import { ipcMain, BrowserWindow, dialog } from 'electron'
import { Client as SshClient, type SFTPWrapper, type FileEntryWithStats } from 'ssh2'
import { randomBytes } from 'node:crypto'
import { readdir, stat as statLocal } from 'node:fs/promises'
import { basename, join as joinLocal } from 'node:path'
import { connectConfig } from './ssh'
import { execPm2Root, pm2Command, PM2_FIND_SCRIPT, readPm2, type Pm2Exec } from '../lib/pm2'
import {
  asScript,
  cpuCores,
  cpuUsage,
  joinPath,
  looksBinary,
  modeToText,
  ownerFromLongname,
  parentPath,
  parseCpuSample,
  parseDisks,
  parseDockerContainers,
  parseDockerImages,
  parseFail2ban,
  parseLogins,
  parseLsListing,
  parseMeminfo,
  parseNet,
  parsePorts,
  parseProcesses,
  parseServiceUnits,
  parseSshd,
  parseUfw,
  parseUpdateLines,
  parseWho,
  q,
  sections,
  typeFromMode,
  type CpuSample,
  type NetSample
} from '../lib/remoteParse'
import type {
  Server,
  Result,
  RemoteHostInfo,
  RemoteEntry,
  RemoteListing,
  RemoteFile,
  RemoteBinary,
  RemoteExec,
  RemoteMetrics,
  SecurityReport,
  UpdateReport,
  ServiceUnit,
  DockerReport,
  Pm2Report,
  Pm2Scope,
  Pm2Action,
  TransferProgress,
  UploadSummary
} from '@shared/types'

/** Bytes of a text file we are willing to pull into the editor. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** Ceiling for an image preview pulled over SFTP and inlined as a data URL. */
const MAX_BINARY_BYTES = 16 * 1024 * 1024

interface Session {
  client: SshClient
  server: Server
  info: RemoteHostInfo
  sftp?: SFTPWrapper
  lastCpu?: CpuSample
  lastNet?: NetSample
  pm2UserBinary?: string
}

const sessions = new Map<string, Session>()
const pending = new Map<string, Promise<Session>>()
/** Servers we are closing on purpose — their `close` event is not a drop-out. */
const closing = new Set<string>()

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function fail(e: unknown): Result<never> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) }
}

// ---------------------------------------------------------------- connection

function execRaw(
  session: Session,
  command: string,
  input?: string,
  timeoutMs = 30000
): Promise<RemoteExec> {
  return new Promise((resolve, reject) => {
    session.client.exec(command, { pty: false }, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          stream.close()
        } catch {
          /* ignore */
        }
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)

      stream.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      stream.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      stream.on('close', (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: code ?? 0, stdout, stderr })
      })
      if (input !== undefined) stream.write(input)
      stream.end()
    })
  })
}

interface RootExec extends RemoteExec {
  /** false when the command had to run unprivileged because sudo was unusable. */
  elevated: boolean
}

const SUDO_NEEDS_PASSWORD = /password is required|no tty present|a terminal is required|askpass/i
const SUDO_BAD_PASSWORD = /incorrect password|Sorry, try again/i

/** The secret to feed `sudo -S`: the dedicated sudo password, else the login one. */
function sudoSecret(server: Server): string | undefined {
  return server.sudoPassword || server.password || undefined
}

/** Run a command as root when possible, falling back to an unprivileged run. */
async function execRoot(session: Session, command: string, timeoutMs = 30000): Promise<RootExec> {
  if (session.info.isRoot) {
    return { ...(await execRaw(session, command, undefined, timeoutMs)), elevated: true }
  }
  const attempt = await execRaw(session, `sudo -n ${command}`, undefined, timeoutMs)
  if (attempt.code !== 127 && !SUDO_NEEDS_PASSWORD.test(attempt.stderr)) {
    return { ...attempt, elevated: true }
  }
  const secret = sudoSecret(session.server)
  if (attempt.code !== 127 && secret) {
    const withPassword = await execRaw(
      session,
      `sudo -S -p '' ${command}`,
      `${secret}\n`,
      timeoutMs
    )
    if (SUDO_BAD_PASSWORD.test(withPassword.stderr)) {
      throw new Error(
        'sudo rejected the password. Set the correct “Sudo password” in this server’s settings.'
      )
    }
    return { ...withPassword, elevated: true }
  }
  return { ...(await execRaw(session, command, undefined, timeoutMs)), elevated: false }
}

const INFO_SCRIPT = [
  'id -un 2>/dev/null || echo unknown',
  'id -u 2>/dev/null || echo 1000',
  'printf "%s\\n" "$HOME"',
  'hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo unknown',
  'uname -r 2>/dev/null || echo unknown',
  '(. /etc/os-release 2>/dev/null && printf "%s\\n" "$PRETTY_NAME") || uname -s 2>/dev/null || echo unknown',
  'printf "%s\\n" "$SHELL"',
  'command -v sudo >/dev/null 2>&1 && echo yes || echo no'
].join('\n')

async function readHostInfo(session: Session): Promise<RemoteHostInfo> {
  const res = await execRaw(session, INFO_SCRIPT, undefined, 20000)
  const [user, uid, home, hostname, kernel, os, shell, hasSudo] = res.stdout.split('\n')
  const isRoot = (uid ?? '').trim() === '0'
  let canSudo = isRoot
  if (!isRoot && (hasSudo ?? '').trim() === 'yes') {
    const probe = await execRaw(session, 'sudo -n true', undefined, 15000)
    canSudo = probe.code === 0 || Boolean(sudoSecret(session.server))
  }
  return {
    user: (user ?? '').trim() || 'unknown',
    home: (home ?? '').trim() || '/',
    hostname: (hostname ?? '').trim() || session.server.host,
    kernel: (kernel ?? '').trim(),
    os: (os ?? '').trim(),
    shell: (shell ?? '').trim(),
    isRoot,
    canSudo
  }
}

/** Identity of the credentials a pooled session was opened with. */
function fingerprint(server: Server): string {
  return [
    server.host,
    server.port,
    server.username,
    server.authType,
    server.keyPath ?? '',
    server.password ?? '',
    server.sudoPassword ?? ''
  ].join(' ')
}

function connect(server: Server): Promise<Session> {
  const existing = sessions.get(server.id)
  if (existing) {
    // Reuse the pooled session unless the server was edited under it.
    if (fingerprint(existing.server) === fingerprint(server)) return Promise.resolve(existing)
    disconnect(server.id)
  }
  const inFlight = pending.get(server.id)
  if (inFlight) return inFlight

  const task = new Promise<Session>((resolve, reject) => {
    const client = new SshClient()
    let settled = false

    client.on('ready', () => {
      const session: Session = {
        client,
        server,
        info: {
          user: server.username,
          home: '/',
          hostname: server.host,
          kernel: '',
          os: '',
          shell: '',
          isRoot: false,
          canSudo: false
        }
      }
      readHostInfo(session)
        .then((info) => {
          session.info = info
          sessions.set(server.id, session)
          settled = true
          resolve(session)
        })
        .catch((e) => {
          settled = true
          try {
            client.end()
          } catch {
            /* ignore */
          }
          reject(e)
        })
    })
    client.on('keyboard-interactive', (_n, _i, _il, _p, finish) => finish([server.password || '']))
    client.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
      // Only retire the pool entry if it still points at *this* client.
      if (sessions.get(server.id)?.client === client) sessions.delete(server.id)
    })
    client.on('close', () => {
      if (sessions.get(server.id)?.client === client) sessions.delete(server.id)
      if (closing.delete(server.id)) return
      broadcast('ops:closed', { serverId: server.id })
    })

    try {
      client.connect(connectConfig(server))
    } catch (e) {
      settled = true
      reject(e as Error)
    }
  }).finally(() => pending.delete(server.id))

  pending.set(server.id, task)
  return task
}

function disconnect(serverId: string): void {
  const s = sessions.get(serverId)
  sessions.delete(serverId)
  if (!s) return
  closing.add(serverId)
  try {
    s.sftp?.end()
  } catch {
    /* ignore */
  }
  try {
    s.client.end()
  } catch {
    /* ignore */
  }
}

function getSftp(session: Session): Promise<SFTPWrapper> {
  if (session.sftp) return Promise.resolve(session.sftp)
  return new Promise((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) {
        reject(err)
        return
      }
      const forget = (): void => {
        if (session.sftp === sftp) session.sftp = undefined
      }
      sftp.on('close', forget)
      sftp.on('error', forget)
      session.sftp = sftp
      resolve(sftp)
    })
  })
}

// ------------------------------------------------------------------ file ops

async function listViaSftp(session: Session, path: string): Promise<RemoteEntry[]> {
  const sftp = await getSftp(session)
  const raw = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)))
  })

  const entries: RemoteEntry[] = raw
    .filter((e) => e.filename !== '.' && e.filename !== '..')
    .map((e) => {
      const { owner, group } = ownerFromLongname(e.longname ?? '')
      return {
        name: e.filename,
        path: joinPath(path, e.filename),
        type: typeFromMode(e.attrs.mode),
        size: e.attrs.size,
        mtime: e.attrs.mtime * 1000,
        mode: e.attrs.mode & 0o7777,
        modeText: modeToText(e.attrs.mode),
        owner,
        group
      }
    })

  // Resolve a bounded number of symlinks so link-to-directory entries stay navigable.
  const links = entries.filter((e) => e.type === 'link').slice(0, 80)
  await Promise.all(
    links.map(
      (entry) =>
        new Promise<void>((resolve) => {
          sftp.stat(entry.path, (err, stats) => {
            if (!err && stats) entry.linkDir = stats.isDirectory()
            resolve()
          })
        })
    )
  )
  return entries
}

async function list(session: Session, path: string): Promise<RemoteListing> {
  try {
    return { path, entries: await listViaSftp(session, path) }
  } catch (e) {
    // Directories SFTP cannot read (0700 root dirs) may still list under sudo.
    const res = await execRoot(session, `ls -Al --time-style=+%s -- ${q(path)}`)
    if (!res.elevated || res.code !== 0) throw e
    return { path, entries: parseLsListing(res.stdout, path), elevated: true }
  }
}

interface Slice {
  buf: Buffer
  size: number
  truncated: boolean
}

/**
 * Read a slice through the shell as root — SFTP runs as the login user, so
 * root-only files (0600 configs, /root, key material) are unreadable over it.
 */
async function readSliceElevated(session: Session, path: string, max: number): Promise<Slice | null> {
  const res = await execRoot(
    session,
    asScript(`stat -c %s -- ${q(path)} 2>/dev/null || echo 0; head -c ${max} -- ${q(path)} | base64`),
    120000
  )
  if (!res.elevated || res.code !== 0) return null
  const nl = res.stdout.indexOf('\n')
  if (nl < 0) return null
  const size = Number(res.stdout.slice(0, nl).trim()) || 0
  const buf = Buffer.from(res.stdout.slice(nl + 1).replace(/\s+/g, ''), 'base64')
  return { buf, size: size || buf.length, truncated: size > buf.length }
}

/** Read at most `max` bytes of a remote file, reporting its full size. */
async function readSlice(session: Session, path: string, max: number): Promise<Slice> {
  try {
    return await readSliceViaSftp(session, path, max)
  } catch (e) {
    const elevated = await readSliceElevated(session, path, max)
    if (!elevated) throw e
    return elevated
  }
}

async function readSliceViaSftp(session: Session, path: string, max: number): Promise<Slice> {
  const sftp = await getSftp(session)
  const stats = await new Promise<{ size: number }>((resolve, reject) => {
    sftp.stat(path, (err, st) => (err ? reject(err) : resolve(st)))
  })
  const chunks: Buffer[] = []
  let read = 0
  await new Promise<void>((resolve, reject) => {
    const stream = sftp.createReadStream(path, { start: 0, end: max })
    stream.on('data', (d: Buffer) => {
      chunks.push(d)
      read += d.length
    })
    stream.on('error', reject)
    stream.on('end', resolve)
    stream.on('close', resolve)
  })
  return { buf: Buffer.concat(chunks), size: stats.size, truncated: stats.size > read }
}

async function readFile(session: Session, path: string): Promise<RemoteFile> {
  const { buf, size, truncated } = await readSlice(session, path, MAX_TEXT_BYTES)
  const binary = looksBinary(buf)
  return {
    path,
    size,
    truncated,
    binary,
    content: binary ? '' : buf.toString('utf8')
  }
}

/** Whole-file read as base64, for previewing images in the file manager. */
async function readBinary(session: Session, path: string): Promise<RemoteBinary> {
  const { buf, size, truncated } = await readSlice(session, path, MAX_BINARY_BYTES)
  if (truncated) {
    throw new Error(
      `That file is ${Math.round(size / 1024 / 1024)} MB — too large to preview. Download it instead.`
    )
  }
  return { path, base64: buf.toString('base64'), size, truncated }
}

function writeFile(session: Session, path: string, content: string): Promise<void> {
  return getSftp(session).then(
    (sftp) =>
      new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(path)
        stream.on('error', reject)
        stream.on('close', () => resolve())
        stream.end(Buffer.from(content, 'utf8'))
      })
  )
}

/** Run a mutating shell command, retrying as root on permission errors. */
async function mutate(session: Session, command: string): Promise<void> {
  const plain = await execRaw(session, command)
  if (plain.code === 0) return
  if (!/permission denied|not permitted|read-only/i.test(plain.stderr)) {
    throw new Error(plain.stderr.trim() || `Command failed (exit ${plain.code})`)
  }
  const elevated = await execRoot(session, command)
  if (elevated.code !== 0) {
    throw new Error(elevated.stderr.trim() || plain.stderr.trim() || 'Permission denied')
  }
}

// ----------------------------------------------------------------- transfers

function reportProgress(p: TransferProgress): void {
  broadcast('ops:progress', p)
}

/** One local file queued for upload, with the path it takes under the target. */
interface UploadItem {
  local: string
  /** Slash-separated path relative to the drop target, e.g. `dist/assets/app.js`. */
  relative: string
}

/**
 * Expand a drop or a picker selection into the files to send and the folders
 * that have to exist first. Dropped folders arrive as a single path, so we walk
 * them here and keep their shape in `relative`.
 */
async function collectUploads(
  localPaths: string[]
): Promise<{ files: UploadItem[]; dirs: string[] }> {
  const files: UploadItem[] = []
  const dirs: string[] = []

  const walk = async (local: string, relative: string): Promise<void> => {
    const st = await statLocal(local)
    if (!st.isDirectory()) {
      files.push({ local, relative })
      return
    }
    // Recorded even when empty, so an empty folder still lands on the server.
    dirs.push(relative)
    for (const child of await readdir(local, { withFileTypes: true })) {
      await walk(joinLocal(local, child.name), `${relative}/${child.name}`)
    }
  }

  for (const local of localPaths) {
    // basename() already copes with trailing separators and Windows paths.
    const name = basename(local)
    if (name) await walk(local, name)
  }
  return { files, dirs }
}

async function upload(
  session: Session,
  localPaths: string[],
  remoteDir: string
): Promise<UploadSummary> {
  const { files, dirs } = await collectUploads(localPaths)
  const sftp = await getSftp(session)

  // Build the tree first — fastPut cannot create missing parents. Batched so a
  // deep folder does not blow past the shell's argument limit.
  for (let i = 0; i < dirs.length; i += 50) {
    const batch = dirs.slice(i, i + 50).map((d) => q(joinPath(remoteDir, d)))
    await mutate(session, `mkdir -p -- ${batch.join(' ')}`)
  }

  let index = 0
  for (const item of files) {
    index++
    const name = item.relative
    const put = (remote: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        sftp.fastPut(
          item.local,
          remote,
          {
            step: (transferred: number, _chunk: number, total: number) =>
              reportProgress({
                serverId: session.server.id,
                kind: 'upload',
                name,
                transferred,
                total,
                index,
                count: files.length,
                done: false
              })
          },
          (err) => (err ? reject(err) : resolve())
        )
      })

    try {
      await put(joinPath(remoteDir, item.relative))
    } catch (e) {
      // Target directory is not writable by the login user: stage the file in
      // /tmp over SFTP, then move it into place with elevated rights.
      if (!session.info.canSudo) throw e
      const temp = `/tmp/hety-${randomBytes(6).toString('hex')}`
      await put(temp)
      try {
        await mutate(session, `mv -- ${q(temp)} ${q(joinPath(remoteDir, item.relative))}`)
      } catch (moveError) {
        await execRaw(session, `rm -f ${q(temp)}`)
        throw moveError
      }
    }
  }
  reportProgress({
    serverId: session.server.id,
    kind: 'upload',
    name: '',
    transferred: 1,
    total: 1,
    index: files.length,
    count: files.length,
    done: true
  })
  return { files: files.length, folders: dirs.length }
}

async function download(
  session: Session,
  remotePath: string,
  localPath: string,
  isDir: boolean
): Promise<void> {
  const sftp = await getSftp(session)
  let source = remotePath
  let tempArchive: string | null = null

  if (isDir) {
    tempArchive = `/tmp/hety-${randomBytes(6).toString('hex')}.tar.gz`
    // Archive as root so unreadable children don't turn into a partial tarball.
    const res = await execRoot(
      session,
      `tar -czf ${q(tempArchive)} -C ${q(parentPath(remotePath))} -- ${q(basename(remotePath))}`,
      600000
    )
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'Could not archive the folder')
    await execRoot(session, `chmod a+r ${q(tempArchive)}`)
    source = tempArchive
  }

  const name = basename(remotePath)
  const get = (remote: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      sftp.fastGet(
        remote,
        localPath,
        {
          step: (transferred: number, _chunk: number, total: number) =>
            reportProgress({
              serverId: session.server.id,
              kind: 'download',
              name,
              transferred,
              total,
              index: 1,
              count: 1,
              done: false
            })
        },
        (err) => (err ? reject(err) : resolve())
      )
    })

  try {
    try {
      await get(source)
    } catch (e) {
      // Not readable by the login user: copy it to /tmp as root, then fetch.
      if (!session.info.canSudo) throw e
      const temp = `/tmp/hety-${randomBytes(6).toString('hex')}`
      const copy = await execRoot(session, asScript(`cp -- ${q(source)} ${q(temp)} && chmod a+r ${q(temp)}`))
      if (!copy.elevated || copy.code !== 0) throw e
      try {
        await get(temp)
      } finally {
        // Root created it in a sticky /tmp, so only root can remove it.
        void execRoot(session, `rm -f ${q(temp)}`).catch(() => undefined)
      }
    }
  } finally {
    if (tempArchive) void execRoot(session, `rm -f ${q(tempArchive)}`).catch(() => undefined)
    reportProgress({
      serverId: session.server.id,
      kind: 'download',
      name,
      transferred: 1,
      total: 1,
      index: 1,
      count: 1,
      done: true
    })
  }
}

// ----------------------------------------------------------------- monitoring

/** One shot of every counter the Monitor tab needs. */
const METRICS_SCRIPT = [
  'echo "@@host"',
  'hostname 2>/dev/null || echo unknown',
  'uname -r 2>/dev/null || echo ""',
  '(. /etc/os-release 2>/dev/null && printf "%s\\n" "$PRETTY_NAME") || echo ""',
  'echo "@@uptime"; cat /proc/uptime 2>/dev/null',
  'echo "@@load"; cat /proc/loadavg 2>/dev/null',
  'echo "@@cpu1"; grep -E "^cpu" /proc/stat 2>/dev/null',
  'sleep 0.4 2>/dev/null || sleep 1',
  'echo "@@cpu2"; grep -E "^cpu" /proc/stat 2>/dev/null',
  'echo "@@mem"; cat /proc/meminfo 2>/dev/null',
  'echo "@@net"; cat /proc/net/dev 2>/dev/null',
  'echo "@@disk"; df -PkT 2>/dev/null | grep -vE "tmpfs|devtmpfs|squashfs|overlay|udev"',
  'echo "@@temp"; for f in /sys/class/thermal/thermal_zone*/temp; do [ -r "$f" ] && cat "$f"; done 2>/dev/null',
  'echo "@@ps"; ps -eo pid=,user=,pcpu=,pmem=,rss=,args= --sort=-pcpu 2>/dev/null | head -n 40',
  'echo "@@pcount"; ps -e 2>/dev/null | wc -l',
  'echo "@@who"; who 2>/dev/null',
  'echo "@@end"'
].join('\n')

async function metrics(session: Session): Promise<RemoteMetrics> {
  const res = await execRaw(session, METRICS_SCRIPT, undefined, 45000)
  if (!res.stdout.includes('@@end') && res.code !== 0) {
    throw new Error(res.stderr.trim() || 'Could not read system metrics')
  }
  const s = sections(res.stdout)
  const now = Date.now()

  const cpu1 = parseCpuSample(s.cpu1 ?? [])
  const cpu2 = parseCpuSample(s.cpu2 ?? [])
  // Prefer the in-script sample pair; fall back to the previous poll when the
  // remote `sleep` was unavailable and both samples came out identical.
  const usableInline = (cpu2.cpu?.total ?? 0) - (cpu1.cpu?.total ?? 0) > 0
  const base = usableInline ? cpu1 : session.lastCpu
  const cores = cpuCores(base, cpu2)
  session.lastCpu = cpu2

  const mem = parseMeminfo(s.mem ?? [])
  const total = mem.MemTotal ?? 0
  const available = mem.MemAvailable ?? mem.MemFree ?? 0
  const swapTotal = mem.SwapTotal ?? 0

  const { interfaces, sample } = parseNet(s.net ?? [], session.lastNet, now)
  session.lastNet = sample

  const uptime = Number((s.uptime?.[0] ?? '').trim().split(/\s+/)[0]) || 0
  const loadParts = (s.load?.[0] ?? '').trim().split(/\s+/)
  const temps = (s.temp ?? [])
    .map((t) => Number(t.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  const temperature = temps.length ? Math.max(...temps) / 1000 : undefined

  return {
    time: now,
    hostname: (s.host?.[0] ?? '').trim() || session.info.hostname,
    kernel: (s.host?.[1] ?? '').trim() || session.info.kernel,
    os: (s.host?.[2] ?? '').trim() || session.info.os,
    uptimeSeconds: uptime,
    load: [Number(loadParts[0]) || 0, Number(loadParts[1]) || 0, Number(loadParts[2]) || 0],
    cpu: {
      usage: cpuUsage(base, cpu2, 'cpu'),
      count: cores.length,
      cores,
      temperature: temperature && temperature < 200 ? temperature : undefined
    },
    memory: {
      total,
      used: Math.max(0, total - available),
      available,
      cached: mem.Cached ?? 0,
      buffers: mem.Buffers ?? 0
    },
    swap: { total: swapTotal, used: Math.max(0, swapTotal - (mem.SwapFree ?? 0)) },
    disks: parseDisks(s.disk ?? []),
    net: interfaces,
    processes: parseProcesses(s.ps ?? []),
    processCount: Math.max(0, Number((s.pcount?.[0] ?? '0').trim()) - 1),
    sessions: parseWho(s.who ?? [])
  }
}

// ------------------------------------------------------------------ security

const SECURITY_SCRIPT = [
  'echo "@@ufw"',
  'command -v ufw >/dev/null 2>&1 && { ufw status verbose 2>/dev/null; echo "---"; ufw status numbered 2>/dev/null; } || echo "NOT_INSTALLED"',
  'echo "@@other"',
  'command -v firewall-cmd >/dev/null 2>&1 && echo firewalld || true',
  'command -v nft >/dev/null 2>&1 && nft list ruleset 2>/dev/null | head -n 1 | grep -q . && echo nftables || true',
  'echo "@@ports"',
  'ss -tulpnH 2>/dev/null || netstat -tulpn 2>/dev/null',
  'echo "@@f2b"',
  'command -v fail2ban-client >/dev/null 2>&1 && { fail2ban-client status 2>/dev/null; for j in $(fail2ban-client status 2>/dev/null | sed -n "s/.*Jail list:[[:space:]]*//p" | tr "," " "); do echo "@@jail $j"; fail2ban-client status "$j" 2>/dev/null; done; } || echo "NOT_INSTALLED"',
  'echo "@@sshd"',
  'sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null || echo "UNAVAILABLE"',
  'echo "@@last"',
  'last -n 12 -w 2>/dev/null | head -n 12',
  'echo "@@lastb"',
  'lastb -n 12 -w 2>/dev/null | head -n 12',
  'echo "@@end"'
].join('\n')

async function security(session: Session): Promise<SecurityReport> {
  const res = await execRoot(session, asScript(SECURITY_SCRIPT), 60000)
  const s = sections(res.stdout)
  // `@@jail <name>` lines carry an argument, so `sections()` keeps them inside
  // the fail2ban block — exactly what the per-jail parser expects.
  return {
    elevated: res.elevated,
    ufw: parseUfw(s.ufw ?? []),
    otherFirewall: (s.other ?? []).map((l) => l.trim()).filter(Boolean)[0],
    ports: parsePorts(s.ports ?? []),
    fail2ban: parseFail2ban(s.f2b ?? []),
    sshd: parseSshd(s.sshd ?? []),
    logins: [...parseLogins(s.last ?? [], false), ...parseLogins(s.lastb ?? [], true)]
  }
}

const UPDATE_SCRIPT = [
  'if command -v apt-get >/dev/null 2>&1; then',
  '  apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null | grep "^Inst"',
  '  echo "@@manager"; echo apt',
  'elif command -v dnf >/dev/null 2>&1; then',
  '  dnf -q check-update 2>/dev/null | grep -E "^[a-zA-Z0-9]"',
  '  echo "@@manager"; echo dnf',
  'elif command -v yum >/dev/null 2>&1; then',
  '  yum -q check-update 2>/dev/null | grep -E "^[a-zA-Z0-9]"',
  '  echo "@@manager"; echo yum',
  'else echo "@@manager"; echo none; fi'
].join('\n')

async function updates(session: Session): Promise<UpdateReport> {
  const res = await execRoot(session, asScript(UPDATE_SCRIPT), 120000)
  const marker = res.stdout.indexOf('@@manager')
  const body = marker >= 0 ? res.stdout.slice(0, marker) : res.stdout
  const manager = marker >= 0 ? res.stdout.slice(marker).split('\n')[1]?.trim() || 'none' : 'none'
  const lines = body.split('\n').filter((l) => l.trim())
  const packages = parseUpdateLines(lines)
  return {
    manager,
    total: packages.length,
    security: lines.filter((l) => /security/i.test(l)).length,
    packages: packages.slice(0, 200)
  }
}

// ------------------------------------------------------------------ services

const SERVICES_SCRIPT = [
  'echo "@@units"',
  'systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null',
  'echo "@@files"',
  'systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>/dev/null',
  'echo "@@end"'
].join('\n')

async function services(session: Session): Promise<ServiceUnit[]> {
  const res = await execRaw(session, SERVICES_SCRIPT, undefined, 40000)
  const s = sections(res.stdout)
  if (!s.units) throw new Error(res.stderr.trim() || 'systemd is not available on this host')
  return parseServiceUnits(s.units, s.files ?? [])
}

// -------------------------------------------------------------------- docker

const DOCKER_PS = `docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}'`
const DOCKER_IMAGES = `docker images --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedSince}}'`
const DOCKER_SCRIPT = [
  'command -v docker >/dev/null 2>&1 || { echo "@@missing"; exit 0; }',
  'echo "@@containers"',
  DOCKER_PS,
  'echo "@@images"',
  DOCKER_IMAGES,
  'echo "@@end"'
].join('\n')

const DOCKER_DENIED = /permission denied|cannot connect to the docker daemon/i

async function docker(session: Session): Promise<DockerReport> {
  let res: RemoteExec = await execRaw(session, DOCKER_SCRIPT, undefined, 40000)
  // The daemon socket is usually root-owned; retry elevated before giving up.
  if (DOCKER_DENIED.test(res.stderr)) {
    res = await execRoot(session, asScript(DOCKER_SCRIPT), 40000)
  }
  if (res.stdout.includes('@@missing')) {
    return { installed: false, accessible: false, containers: [], images: [] }
  }
  if (DOCKER_DENIED.test(res.stderr)) {
    return {
      installed: true,
      accessible: false,
      message: res.stderr.trim().split('\n')[0],
      containers: [],
      images: []
    }
  }
  const s = sections(res.stdout)
  return {
    installed: true,
    accessible: true,
    containers: parseDockerContainers(s.containers ?? []),
    images: parseDockerImages(s.images ?? [])
  }
}

/** Run a docker command, elevating when the socket is root-only. */
async function dockerRun(session: Session, args: string, timeoutMs = 60000): Promise<string> {
  const plain = await execRaw(session, `docker ${args}`, undefined, timeoutMs)
  if (plain.code === 0) return plain.stdout + plain.stderr
  if (!DOCKER_DENIED.test(plain.stderr)) {
    throw new Error(plain.stderr.trim() || `docker exited with ${plain.code}`)
  }
  const elevated = await execRoot(session, `docker ${args}`, timeoutMs)
  if (elevated.code !== 0) throw new Error(elevated.stderr.trim() || 'docker command failed')
  return elevated.stdout + elevated.stderr
}

// ---------------------------------------------------------------- ipc surface

function pm2Exec(session: Session, timeoutMs = 45000): Pm2Exec {
  return async (scope, script) => {
    if (scope === 'root' && !session.info.isRoot) {
      // A global CLI may live in the user's nvm installation. Reuse its binary
      // when root has none, while keeping root's HOME and PM2 daemon separate.
      if (!session.pm2UserBinary) {
        const found = await execRaw(session, `sh -lc ${q(PM2_FIND_SCRIPT)}`, undefined, timeoutMs)
        const candidate = found.stdout.trim().split('\n').pop() ?? ''
        if (found.code === 0 && candidate.startsWith('/')) session.pm2UserBinary = candidate
      }
      return execPm2Root(
        (command, input) => execRaw(session, command, input, timeoutMs),
        `HETY_PM2_FALLBACK=${q(session.pm2UserBinary ?? '')}\n${script}`,
        sudoSecret(session.server)
      )
    }
    const res = await execRaw(session, `sh -lc ${q(script)}`, undefined, timeoutMs)
    const binary = res.stdout.split('@@hety-pm2-meta\n')[1]?.split('\n')[2]?.trim()
    if (scope === 'user' && binary?.startsWith('/')) session.pm2UserBinary = binary
    return res
  }
}

async function pm2Run(session: Session, scope: Pm2Scope, action: Pm2Action | 'logs' | 'save', id?: number, lines?: number): Promise<string> {
  const script = pm2Command(scope, action, id, lines)
  const res = await pm2Exec(session, 60000)(scope, script)
  if (res.code !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `PM2 exited with ${res.code}`)
  return res.stdout + res.stderr
}

type WithServer<T> = T & { server: Server }

/** Wrap a handler so every ops channel returns a Result and never throws. */
function handle<T, A extends { server: Server }>(
  channel: string,
  fn: (session: Session, args: A) => Promise<T>
): void {
  ipcMain.handle(channel, async (_e, args: A): Promise<Result<T>> => {
    try {
      const session = await connect(args.server)
      return { ok: true, data: await fn(session, args) }
    } catch (e) {
      return fail(e)
    }
  })
}

export function registerOpsIpc(): void {
  handle<RemoteHostInfo, WithServer<unknown>>('ops:connect', async (s) => s.info)

  ipcMain.handle('ops:disconnect', (_e, { serverId }: { serverId: string }): Result => {
    disconnect(serverId)
    return { ok: true }
  })

  handle<RemoteExec, WithServer<{ command: string; root?: boolean }>>(
    'ops:exec',
    async (s, { command, root }) =>
      root ? execRoot(s, asScript(command), 120000) : execRaw(s, command, undefined, 120000)
  )

  // ---- files
  handle<string, WithServer<unknown>>('ops:fs:home', async (s) => s.info.home)

  handle<RemoteListing, WithServer<{ path: string }>>('ops:fs:list', (s, { path }) => list(s, path))

  handle<RemoteFile, WithServer<{ path: string }>>('ops:fs:read', (s, { path }) => readFile(s, path))

  handle<RemoteBinary, WithServer<{ path: string }>>('ops:fs:readBinary', (s, { path }) =>
    readBinary(s, path)
  )

  handle<null, WithServer<{ path: string; content: string }>>(
    'ops:fs:write',
    async (s, { path, content }) => {
      try {
        await writeFile(s, path, content)
      } catch (e) {
        // Root-owned files: stage in /tmp, then copy it into place as root.
        if (!s.info.canSudo) throw e
        const temp = `/tmp/hety-${randomBytes(6).toString('hex')}`
        await writeFile(s, temp, content)
        const res = await execRoot(s, asScript(`cat ${q(temp)} > ${q(path)}`))
        await execRaw(s, `rm -f ${q(temp)}`)
        if (res.code !== 0) throw new Error(res.stderr.trim() || 'Could not write the file')
      }
      return null
    }
  )

  handle<null, WithServer<{ path: string }>>('ops:fs:mkdir', async (s, { path }) => {
    await mutate(s, `mkdir -p -- ${q(path)}`)
    return null
  })

  handle<null, WithServer<{ path: string }>>('ops:fs:newFile', async (s, { path }) => {
    const exists = await execRaw(s, `test -e ${q(path)}`)
    if (exists.code === 0) throw new Error('A file with that name already exists')
    await mutate(s, `touch -- ${q(path)}`)
    return null
  })

  handle<null, WithServer<{ from: string; to: string }>>(
    'ops:fs:rename',
    async (s, { from, to }) => {
      const exists = await execRaw(s, `test -e ${q(to)}`)
      if (exists.code === 0) throw new Error('The target name is already taken')
      await mutate(s, `mv -- ${q(from)} ${q(to)}`)
      return null
    }
  )

  handle<null, WithServer<{ paths: string[] }>>('ops:fs:delete', async (s, { paths }) => {
    for (const path of paths) {
      if (path === '/' || !path.startsWith('/')) throw new Error(`Refusing to delete ${path}`)
      await mutate(s, `rm -rf -- ${q(path)}`)
    }
    return null
  })

  handle<null, WithServer<{ path: string; mode: string; recursive?: boolean }>>(
    'ops:fs:chmod',
    async (s, { path, mode, recursive }) => {
      if (!/^[0-7]{3,4}$/.test(mode)) throw new Error('Mode must be 3 or 4 octal digits, e.g. 644')
      await mutate(s, `chmod ${recursive ? '-R ' : ''}${mode} -- ${q(path)}`)
      return null
    }
  )

  handle<null, WithServer<{ path: string; owner: string; recursive?: boolean }>>(
    'ops:fs:chown',
    async (s, { path, owner, recursive }) => {
      if (!/^[\w.-]+(:[\w.-]+)?$/.test(owner)) throw new Error('Use `user` or `user:group`')
      await mutate(s, `chown ${recursive ? '-R ' : ''}${owner} -- ${q(path)}`)
      return null
    }
  )

  handle<null, WithServer<{ op: 'copy' | 'move'; sources: string[]; destDir: string }>>(
    'ops:fs:transfer',
    async (s, { op, sources, destDir }) => {
      const cmd = op === 'copy' ? 'cp -a' : 'mv'
      await mutate(s, `${cmd} -- ${sources.map(q).join(' ')} ${q(destDir)}/`)
      return null
    }
  )

  handle<string, WithServer<{ paths: string[]; destDir: string; name: string }>>(
    'ops:fs:archive',
    async (s, { paths, destDir, name }) => {
      const target = joinPath(destDir, name.endsWith('.tar.gz') ? name : `${name}.tar.gz`)
      const names = paths.map((p) => basename(p))
      await mutate(s, `tar -czf ${q(target)} -C ${q(destDir)} -- ${names.map(q).join(' ')}`)
      return target
    }
  )

  handle<null, WithServer<{ path: string; destDir: string }>>(
    'ops:fs:extract',
    async (s, { path, destDir }) => {
      const lower = path.toLowerCase()
      let cmd: string
      if (lower.endsWith('.zip')) cmd = `unzip -o ${q(path)} -d ${q(destDir)}`
      else if (lower.endsWith('.gz') && !lower.endsWith('.tar.gz')) cmd = `gunzip -kf ${q(path)}`
      else cmd = `tar -xf ${q(path)} -C ${q(destDir)}`
      await mutate(s, cmd)
      return null
    }
  )

  handle<string, WithServer<{ path: string }>>('ops:fs:size', async (s, { path }) => {
    const res = await execRoot(s, `du -sh -- ${q(path)}`, 120000)
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'Could not measure the folder')
    return res.stdout.trim().split(/\s+/)[0] ?? '?'
  })

  handle<string, WithServer<{ path: string; lines?: number }>>(
    'ops:fs:tail',
    async (s, { path, lines }) => {
      const res = await execRoot(s, `tail -n ${Math.min(2000, lines ?? 200)} -- ${q(path)}`)
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'Could not read the file')
      return res.stdout
    }
  )

  handle<
    UploadSummary,
    WithServer<{ remoteDir: string; localPaths?: string[]; folders?: boolean }>
  >('ops:fs:upload', async (s, { remoteDir, localPaths, folders }) => {
    let picks = localPaths
    if (!picks?.length) {
      const win = BrowserWindow.getAllWindows()[0]
      const picked = await dialog.showOpenDialog(win, {
        title: folders ? `Upload a folder to ${remoteDir}` : `Upload to ${remoteDir}`,
        // Windows and Linux honour only one of these, so pick per the caller.
        properties: [folders ? 'openDirectory' : 'openFile', 'multiSelections']
      })
      if (picked.canceled || !picked.filePaths.length) return { files: 0, folders: 0 }
      picks = picked.filePaths
    }
    return upload(s, picks, remoteDir)
  })

  handle<string | null, WithServer<{ path: string; isDir: boolean }>>(
    'ops:fs:download',
    async (s, { path, isDir }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const suggested = isDir ? `${basename(path)}.tar.gz` : basename(path)
      const picked = await dialog.showSaveDialog(win, { defaultPath: suggested })
      if (picked.canceled || !picked.filePath) return null
      await download(s, path, picked.filePath, isDir)
      return picked.filePath
    }
  )

  // ---- monitoring
  handle<RemoteMetrics, WithServer<unknown>>('ops:metrics', (s) => metrics(s))

  handle<null, WithServer<{ pid: number; signal?: string }>>(
    'ops:kill',
    async (s, { pid, signal }) => {
      if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid process id')
      await mutate(s, `kill ${signal === 'KILL' ? '-9' : '-15'} ${pid}`)
      return null
    }
  )

  // ---- security
  handle<SecurityReport, WithServer<unknown>>('ops:security', (s) => security(s))
  handle<UpdateReport, WithServer<unknown>>('ops:updates', (s) => updates(s))

  handle<string, WithServer<{ args: string }>>('ops:ufw', async (s, { args }) => {
    // Only the verbs the UI offers, over a charset with no shell metacharacters.
    const shape =
      /^(--force enable|disable|reload|--force delete \d+|(allow|deny|reject|limit) [\w./: ]+|default (allow|deny|reject) (incoming|outgoing)|logging (on|off|low|medium|high))$/
    if (!shape.test(args) || /[^\w\s./:-]/.test(args)) {
      throw new Error('Unsupported firewall command')
    }
    const res = await execRoot(s, `ufw ${args}`, 45000)
    if (!res.elevated) throw new Error('This needs root — sudo was not available.')
    if (res.code !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || 'ufw failed')
    return res.stdout.trim() || 'Done'
  })

  handle<string, WithServer<{ jail: string; ip: string }>>(
    'ops:fail2banUnban',
    async (s, { jail, ip }) => {
      if (!/^[\w.-]+$/.test(jail) || !/^[0-9a-fA-F.:]+$/.test(ip))
        throw new Error('Invalid jail or IP')
      const res = await execRoot(s, `fail2ban-client set ${jail} unbanip ${ip}`)
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'Could not unban that address')
      return res.stdout.trim()
    }
  )

  // ---- services
  handle<ServiceUnit[], WithServer<unknown>>('ops:services', (s) => services(s))

  handle<string, WithServer<{ unit: string; action: string }>>(
    'ops:serviceAction',
    async (s, { unit, action }) => {
      if (!/^[\w.@:-]+$/.test(unit)) throw new Error('Invalid unit name')
      if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action)) {
        throw new Error('Unsupported service action')
      }
      const res = await execRoot(s, `systemctl ${action} ${unit}`, 60000)
      if (!res.elevated) throw new Error('This needs root — sudo was not available.')
      if (res.code !== 0) throw new Error(res.stderr.trim() || `systemctl ${action} failed`)
      return res.stdout.trim() || `${action} ok`
    }
  )

  handle<string, WithServer<{ unit: string; lines?: number }>>(
    'ops:serviceLogs',
    async (s, { unit, lines }) => {
      if (!/^[\w.@:-]+$/.test(unit)) throw new Error('Invalid unit name')
      const n = Math.min(1000, lines ?? 200)
      const res = await execRoot(
        s,
        asScript(
          `systemctl status ${unit} --no-pager -l -n 0 2>&1; echo; journalctl -u ${unit} -n ${n} --no-pager 2>&1`
        ),
        45000
      )
      return res.stdout || res.stderr
    }
  )

  // ---- docker
  handle<DockerReport, WithServer<unknown>>('ops:docker', (s) => docker(s))

  handle<string, WithServer<{ action: string; id: string }>>(
    'ops:dockerAction',
    async (s, { action, id }) => {
      if (!/^[\w.-]+$/.test(id)) throw new Error('Invalid container id')
      if (!['start', 'stop', 'restart', 'pause', 'unpause', 'rm'].includes(action)) {
        throw new Error('Unsupported container action')
      }
      return dockerRun(s, `${action} ${action === 'rm' ? '-f ' : ''}${id}`)
    }
  )

  handle<string, WithServer<{ id: string; lines?: number }>>(
    'ops:dockerLogs',
    (s, { id, lines }) => {
      if (!/^[\w.-]+$/.test(id)) throw new Error('Invalid container id')
      return dockerRun(s, `logs --tail ${Math.min(2000, lines ?? 300)} ${id}`, 45000)
    }
  )

  handle<string, WithServer<{ target: 'images' | 'containers' | 'system' }>>(
    'ops:dockerPrune',
    (s, { target }) => {
      const scope = target === 'images' ? 'image' : target === 'containers' ? 'container' : 'system'
      return dockerRun(s, `${scope} prune -f`, 180000)
    }
  )

  // ---- PM2 (the user and root daemons are independent)
  handle<Pm2Report, WithServer<unknown>>('ops:pm2', (s) =>
    readPm2(pm2Exec(s), s.info.isRoot, s.info.canSudo)
  )
  handle<string, WithServer<{ scope: Pm2Scope; action: Pm2Action; id: number }>>(
    'ops:pm2Action', (s, { scope, action, id }) => {
      if (!['restart', 'reload', 'stop', 'delete'].includes(action)) throw new Error('Unsupported PM2 action')
      return pm2Run(s, scope, action, id)
    }
  )
  handle<string, WithServer<{ scope: Pm2Scope; id: number; lines?: number }>>(
    'ops:pm2Logs', (s, { scope, id, lines }) => pm2Run(s, scope, 'logs', id, lines)
  )
  handle<string, WithServer<{ scope: Pm2Scope }>>(
    'ops:pm2Save', (s, { scope }) => pm2Run(s, scope, 'save')
  )
}

export { disconnect as disconnectOps }
