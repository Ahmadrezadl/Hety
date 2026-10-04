import { promises as fs, createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Client } from 'ssh2'
import type { Project } from '@shared/types'
import type { CodexAction, CodexAttachment, CodexPermissions, WriteApproval } from '@shared/codex'
import { openConnection, cellToValue, type Connection } from '../ipc/db'
import { connectConfig } from '../ipc/ssh'
import { executeServerCommand } from './codexSsh'
import { stopCodex } from './codex'
import { getDatabaseKindInfo } from '@shared/databases'

export interface ActionContext { getProject: () => Project; cwd?: string; attachments: CodexAttachment[]; permissions: CodexPermissions }
export interface PreparedAction { review: Omit<WriteApproval, 'id'>; execute: (signal: AbortSignal) => Promise<object> }
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const fingerprint = (value: object): string => digest(JSON.stringify(value))
function text(value: unknown, label: string, max = 64000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}.`)
  return value
}
function strings(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 32000 || Object.values(value).some((v) => typeof v !== 'string' || /[\0\r\n]/.test(v))) throw new Error('Invalid request headers or form fields.')
  return { ...value as Record<string, string> }
}
function address(value: unknown): string {
  const url = new URL(text(value, 'URL', 8192))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.')
  return url.href
}
const maskedHeaders = (headers: Record<string, string>): object => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, /authorization|cookie|token|key|secret/i.test(k) ? '[redacted]' : v]))
export async function attachedFile(file: CodexAttachment): Promise<Buffer> {
  const stat = await fs.stat(file.path)
  if (!stat.isFile() || stat.size > 25 * 1024 * 1024 || stat.size !== file.size) throw new Error('The attached file changed or exceeds 25 MB. Attach it again.')
  const buffer = await fs.readFile(file.path)
  if (digest(buffer) !== file.sha256) throw new Error('The attached file changed. Attach it again.')
  return buffer
}
export async function attachmentAt(localPath: string): Promise<CodexAttachment> {
  const real = await fs.realpath(localPath)
  const stat = await fs.stat(real)
  if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('Choose a file up to 25 MB.')
  const buffer = await fs.readFile(real)
  return { id: digest(real + '\0' + digest(buffer)).slice(0, 32), name: path.basename(real), path: real, size: buffer.length, sha256: digest(buffer) }
}
export async function localPath(cwd: string | undefined, requested: string, write = false): Promise<string> {
  if (!cwd) throw new Error('Choose a working folder for local file operations.')
  const root = await fs.realpath(cwd)
  const candidate = path.resolve(root, text(requested, 'local path', 4096))
  const inside = (resolved: string): boolean => { const rel = path.relative(root, resolved); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) }
  if (!inside(candidate)) throw new Error('Local path is outside the working folder.')
  let ancestor = candidate
  while (true) {
    try { if (!inside(await fs.realpath(ancestor))) throw new Error('Local path follows a link outside the working folder.'); break }
    catch (error) { if (!write || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent }
  }
  return candidate
}
export async function inspectLocal(cwd: string | undefined, input: { path?: unknown; operation?: unknown }): Promise<object> {
  const target = await localPath(cwd, typeof input.path === 'string' ? input.path : '.')
  if (input.operation === 'list_directory') {
    const entries = await fs.readdir(target, { withFileTypes: true })
    return { path: target, entries: entries.slice(0, 500).map((e) => ({ name: e.name, directory: e.isDirectory(), link: e.isSymbolicLink() })), truncated: entries.length > 500 }
  }
  if (input.operation !== 'read_file') throw new Error('Use list_directory or read_file.')
  const file = await fs.open(target, 'r')
  try { const stat = await file.stat(); if (!stat.isFile()) throw new Error('Choose a regular file.'); const buffer = Buffer.alloc(Math.min(stat.size, 131072)); const { bytesRead } = await file.read(buffer); return { path: target, content: buffer.subarray(0, bytesRead).toString('utf8'), truncated: stat.size > 131072 } }
  finally { await file.close() }
}

async function deadline<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  if (signal.aborted) throw new Error('Run stopped; no action started.')
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, 45000)
  let cancel: () => void = () => undefined
  const stopped = new Promise<never>((_resolve, reject) => { cancel = () => reject(new Error('Action stopped or timed out. It may have partially applied; inspect the destination before retrying.')); controller.signal.addEventListener('abort', cancel, { once: true }) })
  try { return await Promise.race([stopped, work(controller.signal)]) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); controller.signal.removeEventListener('abort', cancel) }
}
async function requestHttp(action: Extract<CodexAction, {kind:'http_request' | 'http_upload'}>, file: Buffer | undefined, signal: AbortSignal, filename = 'upload'): Promise<object> {
  return deadline(signal, async (signal) => {
    let body: string | FormData | undefined
    if (action.kind === 'http_upload') {
      const form = new FormData()
      for (const [name, value] of Object.entries(action.fields)) form.append(name, value)
      const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.pdf':'application/pdf','.json':'application/json'}
      form.append(action.fieldName, new Blob([new Uint8Array(file!)],{type:mime[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'}), filename)
      body = form
    } else body = action.body
    const response = await fetch(action.url, { method: action.kind === 'http_upload' ? 'POST' : action.method, headers: action.headers, body, signal, redirect: 'error' })
    const reader = response.body?.getReader()
    const chunks: Buffer[] = []
    let bytes = 0, truncated = false
    if (reader) try {
      while (true) { const { value, done } = await reader.read(); if (done) break; const remaining = 120000 - bytes; chunks.push(Buffer.from(value.subarray(0, remaining))); bytes += Math.min(remaining, value.length); if (value.length > remaining) { truncated = true; await reader.cancel(); break } }
    } finally { reader.releaseLock() }
    return { executed: true, success: response.ok, status: response.status, url: response.url, contentType: response.headers.get('content-type'), body: Buffer.concat(chunks).toString('utf8'), truncated }
  })
}
async function uploadSsh(server: Project['servers'][number], remotePath: string, file: Buffer, signal: AbortSignal): Promise<object> {
  return deadline(signal, (signal) => new Promise((resolve, reject) => {
    const client = new Client()
    client.on('error', () => undefined)
    let settled = false
    const finish = (error?: Error): void => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); client.destroy(); if (error) reject(error); else resolve({ executed: true, success: true, remotePath, bytes: file.length }) }
    const abort = (): void => finish(new Error('Upload stopped; a partial file may remain at the destination.'))
    signal.addEventListener('abort', abort, { once: true })
    client.once('error', finish)
    client.once('close', () => { if (!settled) finish(new Error('SSH connection closed before the upload completed.')) })
    client.on('keyboard-interactive', (_n, _i, _l, prompts, reply) => reply(prompts.map(() => server.password ?? '')))
    client.once('ready', () => client.sftp((error, sftp) => {
      if (settled || signal.aborted) return
      if (error) { finish(error); return }
      const stream = sftp.createWriteStream(remotePath, { flags: 'w' })
      let finished=false
      stream.once('finish',() => {finished=true})
      stream.once('error', finish)
      stream.once('close', () => finish(finished ? undefined : new Error('Upload closed before completion; a partial file may remain.')))
      stream.end(file)
    }))
    if (signal.aborted) { abort(); return }
    try { client.connect(connectConfig(server)) } catch (error) { finish(error as Error) }
  }))
}

export async function prepareAction(kind: CodexAction['kind'], input: Record<string, unknown>, context: ActionContext): Promise<PreparedAction> {
  const reason = text(input.reason, 'reason', 2000)
  const project = context.getProject()
  const permission = (key: keyof CodexPermissions): void => { if (!context.permissions[key]) throw new Error(`Write requests for ${key} are disabled. Enable the checkbox and send a new prompt.`) }
  const review = (target: string, details: string, warning: string, language?: string): Omit<WriteApproval,'id'> => ({ kind, title: kind.replaceAll('_',' '), target, reason, details, warning, language })
  const resource = <T extends {id:string}>(items: T[], id: unknown): T => { const item = items.find((r) => r.id === id); if (!item) throw new Error('Resource not found in this project.'); return item }
  const currentResource = <T extends object>(original: T, lookup: () => T): T => { const current = lookup(); if (fingerprint(current) !== fingerprint(original)) throw new Error('The saved connection changed after approval was requested. Request a new approval.'); return current }
  const file = (): CodexAttachment => resource(context.attachments, input.fileId)
  if (kind === 'database_write') {
    permission('databaseWrites')
    const db = { ...resource(project.databases, input.databaseId) }
    if(!getDatabaseKindInfo(db.kind).supported)throw new Error('This database engine is not supported in this Hety build.')
    const server = db.useSsh ? { ...resource(project.servers, db.sshServerId) } : undefined
    const sql = text(input.sql, 'SQL')
    return { review: review(`${db.name} · ${db.host}:${db.port}/${db.database}${server ? ` via ${server.name}` : ''}`, sql, 'This can change or delete database data. SQL is executed exactly as shown. A failed or stopped batch may partially apply unless you include a transaction. The database tab stays locked.', 'sql'), execute: (signal) => deadline(signal, async (signal) => {
      currentResource(db, () => resource(context.getProject().databases, db.id)); if (server) currentResource(server, () => resource(context.getProject().servers, server.id))
      let connection: Connection | undefined
      const stop = (): void => { connection?.tunnel?.close(); connection?.driver.abort?.(); if (connection && !connection.driver.abort) void connection.driver.close().catch(() => undefined) }
      signal.addEventListener('abort', stop, {once:true})
      try {
        connection = await openConnection(db, server, () => undefined, {signal,timeoutMs:30000})
        if (signal.aborted) throw new Error('Run stopped.')
        const result = await connection.driver.query(sql)
        let bytes=Buffer.byteLength(JSON.stringify(result.columns)),truncated=result.rows.length>100
        const columns=bytes>120000 ? [] : result.columns
        const rows:ReturnType<typeof cellToValue>[][]=[]
        for(const row of result.rows.slice(0,100)){const cells=row.map(cellToValue),size=Buffer.byteLength(JSON.stringify(cells));if(bytes+size>120000){truncated=true;break}bytes+=size;rows.push(cells)}
        const lastTransaction=result.statements ? [...result.statements].reverse().find((stmt) => ['BEGIN','COMMIT','ROLLBACK'].includes(stmt.command))?.command : result.command
        const openTransaction=lastTransaction==='BEGIN',rolledBack=lastTransaction==='ROLLBACK'
        const affectedRows=openTransaction || rolledBack ? null : result.statements ? result.statements.filter((stmt) => ['INSERT','UPDATE','DELETE','MERGE'].includes(stmt.command)).reduce((count,stmt) => count+stmt.rowCount,0) : result.command==='SELECT' ? 0 : result.rowCount
        return {executed:true,success:!openTransaction,command:result.command?.slice(0,4000),affectedRows,transactionOutcome:openTransaction ? 'Open transaction will be rolled back when this isolated connection closes. Earlier committed statements may still have applied; inspect before retrying.' : rolledBack ? 'Batch ended with ROLLBACK. Do not report its rolled-back changes as applied.' : 'Statement or batch completed.',statements:result.statements?.slice(0,100),columns,rows,truncated:truncated || result.columns.length!==columns.length}
      } catch (error) { let message = (error as Error).message; for (const secret of [db.password, server?.password, server?.sudoPassword, server?.keyPassphrase]) if (secret) message=message.split(secret).join('[redacted]'); throw new Error(message) }
      finally { signal.removeEventListener('abort',stop); connection?.tunnel?.close(); if(connection)void connection.driver.close().catch(() => undefined) }
    }) }
  }
  if (kind === 'ssh_execute' || kind === 'ssh_upload') {
    permission(kind === 'ssh_execute' ? 'serverWrites' : 'uploads')
    const server = { ...resource(project.servers, input.serverId) }
    const target = `${server.name} · ${server.username}@${server.host}:${server.port}`
    const check = (): void => { currentResource(server, () => resource(context.getProject().servers, server.id)) }
    if (kind === 'ssh_execute') {
      const command = text(input.command,'server command')
      if (input.sudo !== undefined && typeof input.sudo !== 'boolean') throw new Error('Invalid sudo flag.')
      const sudo = input.sudo === true
      return {review:review(target,command,`This command may change files, databases, APIs and services${sudo ? ' with sudo privileges' : ''}. Review the entire command. A failed or stopped command may partially apply.`, 'sh'),execute:async (signal) => { check(); const result=await executeServerCommand(server,command,sudo,signal);return {...result,executed:true,success:result.code===0&&!result.truncated,...(result.truncated ? {outcome:'Output limit interrupted the command; it may have partially applied. Inspect before retrying.'} : {})} }}
    }
    const attached = file()
    await attachedFile(attached)
    const remotePath = text(input.remotePath,'remote path',4096)
    if (!remotePath.startsWith('/') || /[\r\n]/.test(remotePath)) throw new Error('Provide an absolute remote file path.')
    return {review:review(`${target} → ${remotePath}`,JSON.stringify({file:attached.name,bytes:attached.size,sha256:attached.sha256,destination:remotePath},null,2),'Upload over SFTP. An existing destination file will be overwritten. A failed upload can leave a partial file.','json'),execute:async (signal) => {check(); const buffer=await attachedFile(attached);return uploadSsh(server,remotePath,buffer,signal)}}
  }
  if (kind === 'http_request' || kind === 'http_upload') {
    const url=address(input.url),headers=strings(input.headers)
    if (kind === 'http_upload') {
      permission('uploads'); permission('apiWrites')
      if(Object.keys(headers).some((name) => ['content-type','content-length'].includes(name.toLowerCase())))throw new Error('Multipart Content-Type and length are generated automatically. Omit those headers.')
      const attached=file();await attachedFile(attached)
      const fields=strings(input.fields),fieldName=typeof input.fieldName === 'string' ? text(input.fieldName,'field name',200) : 'file'
      const action: Extract<CodexAction,{kind:'http_upload'}>={kind,url,headers,fields,fieldName,fileId:attached.id,reason}
      return {review:review(`POST ${url}`,JSON.stringify({headers:maskedHeaders(headers),fields,fieldName,file:attached.name,bytes:attached.size,sha256:attached.sha256},null,2),'Upload a multipart file to this API. This may replace files or modify application records. Redirects are refused.','json'),execute:async (signal) => requestHttp(action,await attachedFile(attached),signal,attached.name)}
    }
    const method=text(input.method,'HTTP method',10).toUpperCase() as Extract<CodexAction,{kind:'http_request'}>['method']
    if (!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method)) throw new Error('Unsupported HTTP method.')
    if (!['GET','HEAD'].includes(method)) permission('apiWrites')
    if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 128000)) throw new Error('Invalid request body.')
    if (['GET','HEAD'].includes(method) && input.body !== undefined) throw new Error('Read-only HTTP requests cannot have a body.')
    const action: Extract<CodexAction,{kind:'http_request'}>={kind,url,method,headers,body:input.body as string | undefined,reason}
    return {review:review(`${method} ${url}`,JSON.stringify({headers:maskedHeaders(headers),body:action.body},null,2),'This request can update or delete application data. Only this URL, method and body are approved. Redirects are refused.','json'),execute:(signal) => requestHttp(action,undefined,signal)}
  }
  permission('localWrites')
  if (!context.cwd) throw new Error('Choose a working folder for local writes.')
  if (kind === 'local_write') {
    const target=await localPath(context.cwd,text(input.path,'local path',4096),true)
    if (typeof input.content !== 'string' || input.content.length > 128000 || input.content.includes('\0')) throw new Error('Invalid file content.')
    const content=input.content
    const snapshot=async ():Promise<string | null> => {try {const hash=createHash('sha256');for await(const chunk of createReadStream(target))hash.update(chunk);return hash.digest('hex')} catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}}
    const before=await snapshot()
    return {review:review(target,content,`${before===null ? 'Create this file and any missing parent directories.' : 'Replace the entire existing file.'} This requires approval even when local writes are enabled.`,path.extname(target).slice(1)),execute:async (signal) => {
      context.getProject();await localPath(context.cwd,target,true);if(await snapshot()!==before)throw new Error('The file changed while awaiting approval. Request a new approval.')
      if(signal.aborted)throw new Error('Run stopped.');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content,'utf8');return {executed:true,success:true,path:target,bytes:Buffer.byteLength(content)}
    }}
  }
  if (kind !== 'local_execute') throw new Error('Unknown write action.')
  const executable=text(input.executable,'executable',4096)
  if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some((a) => typeof a!=='string'||a.includes('\0')) || JSON.stringify(input.args).length>64000)throw new Error('Invalid command arguments.')
  const args=[...input.args] as string[]
  const cwd=context.cwd
  return {review:review(cwd,JSON.stringify({executable,args},null,2),'This program can change local files, Git state and remote systems using your account. Review all arguments. It runs in the selected folder, without a sandbox.','json'),execute:(signal) => deadline(signal,(signal) => new Promise((resolve,reject) => {
    context.getProject();if(signal.aborted){reject(new Error('Run stopped.'));return}
    const child=spawn(executable,args,{cwd,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='',truncated=false
    const stop=():void => stopCodex(child)
    signal.addEventListener('abort',stop,{once:true})
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
    child.stdout.on('data',(data:string) => {if(stdout.length+data.length>120000)truncated=true;stdout=(stdout+data).slice(-120000)});child.stderr.on('data',(data:string) => {if(stderr.length+data.length>8000)truncated=true;stderr=(stderr+data).slice(-8000)})
    child.once('error',(error) => {signal.removeEventListener('abort',stop);reject(error)})
    child.once('close',(code) => {signal.removeEventListener('abort',stop);resolve({executed:true,success:code===0,code,stdout,stderr,truncated})})
  }))}
}
