import { app, ipcMain, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Result, AppData, Database } from '@shared/types'
import { buildCodexPrompt, DEFAULT_CODEX_PERMISSIONS, HETY_CODEX_INTEGRATION_VERSION, type CodexRequest, type CodexEvent, type DatabaseApproval, type WriteApproval } from '@shared/codex'
import { getData, save, flush } from '../lib/store'
import { checkCodex, findCodex, spawnCodex, stopCodex, codexIsolationArgs } from '../lib/codex'
import { startHetyBridge, databaseProposal, HETY_TOOL_NAMES } from '../lib/hetyMcp'
import { inspectServer } from '../lib/codexSsh'
import { inspectDatabase } from '../lib/codexDb'
import { attachmentAt, attachedFile, prepareAction, inspectLocal } from '../lib/codexActions'

interface Run {
  owner: WebContents
  projectId: string
  child?: ChildProcessWithoutNullStreams
  cancelled: boolean
  controller: AbortController
  bridge?: { close: () => void }
  approval?: { draft: DatabaseApproval; complete: (result: object) => void; resolving?: boolean }
  writeApproval?: { draft: WriteApproval; execute: (signal: AbortSignal) => Promise<object>; complete: (result: object) => void; resolving: boolean; begin: () => void }
}
const runs = new Map<string, Run>()

function send(runId: string, run: Run, payload: Omit<CodexEvent, 'runId' | 'projectId'>): void {
  if (!run.owner.isDestroyed()) run.owner.send('codex:event', { ...payload, runId, projectId: run.projectId })
}

function dispose(run: Run): void {
  run.approval?.complete({ added: false, reason: 'Run stopped before approval.' })
  run.writeApproval?.complete(run.writeApproval.resolving ? {approved:true,outcome:'Stopped during execution; may have partially applied. Inspect before retrying.'} : {approved:false,executed:false,reason:'Run stopped before approval.'})
  run.controller.abort()
  run.bridge?.close()
}

function validate(request: CodexRequest): void {
  if (!request || typeof request.runId !== 'string' || !/^[\w-]{1,80}$/.test(request.runId) ||
    typeof request.projectId !== 'string' || typeof request.prompt !== 'string' ||
    !request.prompt.trim() || request.prompt.length > 32_000 ||
    typeof request.allowEdits !== 'boolean' || !Array.isArray(request.history) || request.history.length > 20 ||
    request.history.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string') ||
    JSON.stringify(request.history).length > 64_000 ||
    (request.folder !== undefined && typeof request.folder !== 'string') ||
    (request.repositoryId !== undefined && typeof request.repositoryId !== 'string')) {
    throw new Error('Invalid Codex request. Prompts are limited to 32,000 characters.')
  }
  if (request.permissions !== undefined && (!request.permissions || Object.keys(DEFAULT_CODEX_PERMISSIONS).some((key) => typeof request.permissions![key as keyof typeof DEFAULT_CODEX_PERMISSIONS] !== 'boolean'))) throw new Error('Invalid write permissions.')
  if (request.attachments !== undefined && (!Array.isArray(request.attachments) || request.attachments.length > 20 || request.attachments.some((file) => !file || typeof file.path !== 'string' || !path.isAbsolute(file.path) || typeof file.id !== 'string' || typeof file.sha256 !== 'string'))) throw new Error('Invalid attached files.')
}

export function registerCodexIpc(): void {
  ipcMain.handle('codex:attachment', async (_event, localPath: string) => {
    try { if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) throw new Error('Choose an absolute file path.'); return {ok:true,data:await attachmentAt(localPath)} }
    catch(error){return {ok:false,error:(error as Error).message}}
  })
  ipcMain.handle('codex:status', async (_event, force?: boolean) => ({
    ...await checkCodex(force === true),
    integrationVersion: HETY_CODEX_INTEGRATION_VERSION,
    tools: [...HETY_TOOL_NAMES]
  }))
  ipcMain.handle('codex:start', async (event, request: CodexRequest): Promise<Result> => {
    let run: Run | undefined
    try {
      validate(request)
      if (runs.has(request.runId) || [...runs.values()].some((r) => r.owner.id === event.sender.id && r.projectId === request.projectId)) {
        throw new Error('Codex is already running for this project.')
      }
      const project = getData().projects.find((p) => p.id === request.projectId)
      if (!project) throw new Error('Project not found.')
      const repository = project.repositories?.find((r) => r.id === request.repositoryId)
      if (request.repositoryId && !repository) throw new Error('Repository not found.')
      const folder = repository?.path || request.folder
      if (folder && !path.isAbsolute(folder)) throw new Error('Working folder must be an absolute path.')
      if (!folder && request.allowEdits) throw new Error('Choose a working folder before enabling local file edits.')
      // Reserve before asynchronous checks so duplicate starts cannot race.
      run = { owner: event.sender, projectId: project.id, cancelled: false, controller: new AbortController() }
      runs.set(request.runId, run)
      // Server/Hety tasks work without a repository. Keep their local sandbox
      // in an isolated scratch directory rather than the app installation.
      const scratch = path.join(app.getPath('userData'), 'codex-workspaces', createHash('sha256').update(project.id).digest('hex').slice(0, 24))
      if (!folder) await fs.mkdir(scratch, { recursive: true })
      const cwd = await fs.realpath(folder || scratch)
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Working folder is not a directory.')
      const status = await checkCodex()
      if (!status.installed || !status.authenticated) throw new Error(status.message || 'Sign in to Codex first.')
      const launcher = await findCodex()
      if (!launcher) throw new Error('Codex CLI is no longer available. Check the installation again.')
      const isolationArgs=await codexIsolationArgs(launcher,cwd)
      if (run.cancelled || event.sender.isDestroyed()) throw new Error('Codex run cancelled.')
      const current = run
      const permissions = { ...(request.permissions ?? { ...DEFAULT_CODEX_PERMISSIONS, localWrites: request.allowEdits }), localWrites: !!folder && (request.permissions?.localWrites ?? request.allowEdits) }
      const attachments = await Promise.all((request.attachments ?? []).map(async (file) => { await attachedFile(file); const verified=await attachmentAt(file.path); if(verified.id!==file.id)throw new Error('The attached file changed. Attach it again.'); return verified }))
      request = { ...request, permissions, attachments }
      const getProject = (): typeof project => {
        if (current.controller.signal.aborted) throw new Error('Run stopped.')
        const currentProject = getData().projects.find((p) => p.id === project.id)
        if (!currentProject) throw new Error('Project was removed.')
        return currentProject
      }
      let toolsListed = false
      const bridge = await startHetyBridge({
        getProject,
        signal: current.controller.signal,
        onToolsListed: (tools) => {
          if (toolsListed) return
          toolsListed = true
          send(request.runId, current, { type: 'tools', tools })
        },
        activity: (text) => send(request.runId, current, { type: 'activity', text }),
        localInspect: (input) => inspectLocal(folder ? cwd : undefined,input),
        action: async (kind,input) => {
          const prepared = await prepareAction(kind,input,{getProject,cwd:folder ? cwd : undefined,attachments,permissions})
          if (kind==='http_request' && ['GET','HEAD'].includes(String(input.method).toUpperCase())) return prepared.execute(current.controller.signal)
          return new Promise((resolve,reject) => {
            if (current.approval || current.writeApproval) {reject(new Error('Review the pending action first, then submit writes sequentially.'));return}
            if (current.cancelled || current.owner.isDestroyed() || current.controller.signal.aborted) {resolve({approved:false,executed:false,reason:'Run stopped.'});return}
            const draft:WriteApproval={...prepared.review,id:randomUUID()}
            let settled=false
            const timer=setTimeout(() => current.writeApproval?.complete({approved:false,executed:false,reason:'Approval expired. No action was executed.'}),540000)
            current.writeApproval={draft,execute:prepared.execute,resolving:false,begin:() => clearTimeout(timer),complete:(result) => {
              if(settled)return;settled=true;clearTimeout(timer);current.writeApproval=undefined
              send(request.runId,current,{type:'approval'});resolve(result)
            }}
            send(request.runId,current,{type:'activity',text:`Waiting for approval: ${draft.title}`})
            send(request.runId,current,{type:'approval',writeApproval:draft})
          })
        },
        inspect: (serverId, input) => {
          const server = getProject().servers.find((s) => s.id === serverId)
          if (!server) throw new Error('Server not found in this project.')
          return inspectServer(server, input, current.controller.signal)
        },
        database: (databaseId, input) => {
          const project = getProject()
          const database = project.databases.find((db) => db.id === databaseId)
          if (!database) throw new Error('Database not found in this project.')
          const server = database.useSsh ? project.servers.find((s) => s.id === database.sshServerId) : undefined
          if (database.useSsh && !server) throw new Error('The database’s SSH server was removed from this project.')
          return inspectDatabase(database, server, input, current.controller.signal)
        },
        propose: (database, source) => new Promise((resolve, reject) => {
          if (current.approval || current.writeApproval) { reject(new Error('Review the pending action first.')); return }
          if (current.cancelled || current.owner.isDestroyed()) { resolve({ added: false, reason: 'Run stopped.' }); return }
          const draft: DatabaseApproval = { id: randomUUID(), database, source }
          let settled = false
          const timer = setTimeout(() => {
            current.approval?.complete({ added: false, reason: 'Approval expired. Ask again to propose the connection.' })
          }, 540_000)
          current.approval = { draft, complete: (result) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            current.approval = undefined
            send(request.runId, current, { type: 'approval' })
            resolve(result)
          } }
          send(request.runId, current, { type: 'approval', approval: draft })
        })
      })
      run.bridge = bridge
      if (run.cancelled || event.sender.isDestroyed()) throw new Error('Codex run cancelled.')
      const prompt = buildCodexPrompt(project, request, cwd)
      if (prompt.length > 256_000) throw new Error('Project context is too large for this run.')
      const child = spawnCodex(launcher, [
        ...isolationArgs,
        // Hety enforces the database approval itself, in its review card.
        '-c', `mcp_servers.hety={url=${JSON.stringify(bridge.url)},enabled=true,required=true,tool_timeout_sec=600,default_tools_approval_mode="approve"}`,
        '--ask-for-approval', 'never', 'exec', '--json', '--color', 'never',
        '--sandbox', 'read-only',
        '--skip-git-repo-check', '-'
      ], cwd)
      run.child = child
      const emit = (payload: Omit<CodexEvent, 'runId' | 'projectId'>): void => send(request.runId, current, payload)
      let finished = false
      let failed = false
      let stderr = ''
      let buffered = ''
      const destroyed = (): void => { current.cancelled = true; dispose(current); stopCodex(child) }
      event.sender.once('destroyed', destroyed)
      const finish = (success: boolean, error?: string): void => {
        if (finished) return
        finished = true
        runs.delete(request.runId)
        dispose(current)
        event.sender.removeListener('destroyed', destroyed)
        if (error && !current.cancelled) emit({ type: 'error', text: error })
        emit({ type: 'done', success: success && !failed && !current.cancelled, cancelled: current.cancelled })
      }
      const line = (raw: string): void => {
        if (!raw.trim()) return
        try {
          const data = JSON.parse(raw)
          if (data.type === 'error' || data.type === 'turn.failed') {
            failed = true
            emit({ type: 'error', text: String(data.message || data.error?.message || 'Codex run failed.').slice(0, 32_000) })
          } else if (data.type === 'item.completed' && data.item?.type === 'agent_message') {
            if (toolsListed) emit({ type: 'message', text: String(data.item.text ?? '').slice(0, 64_000) })
          } else if (data.type === 'item.started' || data.type === 'item.completed') {
            const item = data.item
            const text = item?.type === 'command_execution' ? item.command :
              item?.type === 'reasoning' ? item.text :
              item?.type === 'file_change' ? 'Updating local files…' :
              item?.type === 'web_search' ? 'Searching the web…' :
              item?.type === 'mcp_tool_call' ? `Using ${item.server ?? 'a connected tool'}: ${item.tool ?? 'tool'}…` : 'Working…'
            emit({ type: 'activity', text: String(text ?? 'Working…').slice(0, 2000) })
          }
        } catch { /* Ignore non-JSON startup diagnostics from CLI versions. */ }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk
        let index: number
        while ((index = buffered.indexOf('\n')) >= 0) {
          line(buffered.slice(0, index)); buffered = buffered.slice(index + 1)
        }
        if (buffered.length > 2_000_000) {
          failed = true; stopCodex(child); finish(false, 'Codex output exceeded the stream limit.')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_000) })
      child.stdin.on('error', (error) => { if (!current.cancelled) { stopCodex(child); finish(false, error.message) } })
      child.on('error', (error) => finish(false, error.message))
      child.on('close', (code) => {
        line(buffered)
        const missingTools = code === 0 && !toolsListed && !current.cancelled
        finish(code === 0 && toolsListed, missingTools ? 'Codex did not load Hety’s tools. No database or server tasks were performed. Restart Hety and retry; if this continues, check the Codex MCP configuration.' : code !== 0 && !failed ? stderr.trim() || `Codex exited with code ${code}.` : undefined)
      })
      // Prompts go through stdin; user text is never a shell argument.
      child.stdin.end(prompt, 'utf8')
      return { ok: true }
    } catch (error) {
      if (run) { dispose(run); runs.delete(request.runId) }
      return { ok: false, error: (error as Error).message }
    }
  })
  ipcMain.handle('codex:approveWrite', async (event,input:{runId:string;id:string;approve:boolean}):Promise<Result> => {
    if(!input || typeof input.approve!=='boolean')return {ok:false,error:'Invalid approval.'}
    const run=runs.get(input.runId)
    if(!run || run.owner.id!==event.sender.id)return {ok:false,error:'This approval does not belong to this window.'}
    const pending=run.writeApproval
    if(!pending || pending.draft.id!==input.id || pending.resolving || run.cancelled || run.controller.signal.aborted)return {ok:false,error:'This action is no longer pending.'}
    if(!input.approve){pending.complete({approved:false,executed:false,reason:'User declined this action. Do not retry it without a new user request.'});return {ok:true}}
    pending.resolving=true;pending.begin()
    send(input.runId,run,{type:'activity',text:`Executing approved action: ${pending.draft.title}`})
    try {
      const result=await pending.execute(run.controller.signal)
      pending.complete({...result,approved:true})
      return {ok:true}
    } catch(error){
      const message=(error as Error).message
      pending.complete({approved:true,success:false,outcome:'Failed or unknown; inspect the destination before retrying.',error:message})
      send(input.runId,run,{type:'error',text:message})
      return {ok:false,error:message}
    }
  })
  ipcMain.handle('codex:approveDatabase', async (event, input: { runId: string; id: string; approve: boolean; database?: Database }): Promise<Result<AppData>> => {
    try {
      if (!input || typeof input.approve !== 'boolean') throw new Error('Invalid approval.')
      const run = runs.get(input.runId)
      if (!run || run.owner.id !== event.sender.id) throw new Error('This approval does not belong to this window.')
      const pending = run.approval
      if (!pending || pending.draft.id !== input.id || run.cancelled || pending.resolving) throw new Error('This proposal is no longer pending.')
      if (!input.approve) { pending.complete({ added: false, reason: 'User declined to add the connection.' }); return { ok: true } }
      const data = getData()
      const project = data.projects.find((p) => p.id === run.projectId)
      if (!project) throw new Error('Project was removed.')
      const { database } = databaseProposal({ ...(input.database ?? pending.draft.database), source: pending.draft.source }, project)
      database.id = pending.draft.database.id
      if (project.databases.some((db) => db.id === database.id)) throw new Error('This connection has already been added.')
      pending.resolving = true
      try {
        await save({ ...data, projects: data.projects.map((p) => p.id === project.id ? { ...p, databases: [...p.databases, database] } : p) })
        await flush()
      } catch (error) {
        // The vault updates its in-memory snapshot before flushing. Restore
        // just this failed insertion so the proposal can be reviewed/retried.
        const latest = getData()
        await save({ ...latest, projects: latest.projects.map((p) => p.id === project.id ? { ...p, databases: p.databases.filter((db) => db.id !== database.id) } : p) }).catch(() => undefined)
        await flush().catch(() => undefined)
        pending.resolving = false
        throw error
      }
      pending.complete({ added: true, database: { id: database.id, name: database.name, host: database.host, database: database.database, useSsh: database.useSsh, sshServerId: database.sshServerId } })
      return { ok: true, data: getData() }
    } catch (error) { return { ok: false, error: (error as Error).message } }
  })
  ipcMain.handle('codex:cancel', (event, runId: string): Result => {
    const run = runs.get(runId)
    if (!run) return { ok: true }
    if (run.owner.id !== event.sender.id) return { ok: false, error: 'This run belongs to another window.' }
    run.cancelled = true
    dispose(run)
    if (run.child) stopCodex(run.child)
    return { ok: true }
  })
  app.on('before-quit', () => { for (const run of runs.values()) { dispose(run); if (run.child) stopCodex(run.child) } })
}
