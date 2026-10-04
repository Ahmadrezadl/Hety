import { Client, type ClientChannel } from 'ssh2'
import type { Server, RemoteExec } from '@shared/types'
import { connectConfig } from '../ipc/ssh'
import { q } from './remoteParse'

export const SSH_INSPECTIONS = ['overview', 'list_directory', 'find_configs', 'read_file', 'processes', 'process_environment', 'services', 'service_config', 'docker', 'docker_config'] as const
export type SshInspection = (typeof SSH_INSPECTIONS)[number]
export interface Inspection { operation: SshInspection; path?: string; target?: string; sudo?: boolean }

/** Structured, read-only operations: no arbitrary model-supplied shell script. */
export function inspectionScript(input: Inspection): string {
  if (!input || !SSH_INSPECTIONS.includes(input.operation) ||
    (input.sudo !== undefined && typeof input.sudo !== 'boolean')) throw new Error('Unknown SSH inspection.')
  const remotePath = (): string => {
    if (typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.length > 4096 || /[\0\r\n]/.test(input.path)) {
      throw new Error('Provide an absolute remote path.')
    }
    return q(input.path)
  }
  const target = (): string => {
    if (typeof input.target !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,255}$/.test(input.target)) throw new Error('Provide a valid service, container, or process identifier.')
    return q(input.target)
  }
  switch (input.operation) {
    case 'overview': return 'id; hostname; uname -a; printf "Home: %s\\n" "$HOME"; ls -la /var/www /opt /srv /etc/systemd/system /etc/nginx/sites-enabled 2>/dev/null'
    case 'list_directory': return `ls -la -- ${remotePath()}`
    case 'find_configs': return `find ${remotePath()} -maxdepth 5 -type f \\( -name '.env*' -o -name '*compose*.yml' -o -name '*compose*.yaml' -o -name '*database*.yml' -o -name '*database*.yaml' -o -name '*config*.json' -o -name '*config*.php' -o -name 'wp-config.php' -o -name 'appsettings*.json' -o -name 'ecosystem.config.*' -o -name '*.service' \\) -print 2>/dev/null`
    case 'read_file': return `head -c 131072 -- ${remotePath()}`
    case 'processes': return 'ps -eo pid,user,args --sort=pid'
    case 'process_environment': {
      if (typeof input.target !== 'string' || !/^[1-9][0-9]{0,9}$/.test(input.target)) throw new Error('Provide a numeric process id.')
      return `tr '\\0' '\\n' < ${q(`/proc/${input.target}/environ`)}`
    }
    case 'services': return 'systemctl list-units --type=service --all --no-pager --plain'
    case 'service_config': return `systemctl show --no-pager -p User -p WorkingDirectory -p ExecStart -p Environment -p EnvironmentFiles -- ${target()}; systemctl cat --no-pager -- ${target()}`
    case 'docker': return 'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Ports}}"'
    case 'docker_config': return `docker inspect -- ${target()}`
  }
}

export async function inspectServer(server: Server, input: Inspection, signal: AbortSignal): Promise<RemoteExec & { truncated: boolean }> {
  return executeServerCommand(server, inspectionScript(input), !!input.sudo, signal)
}

/** Caller must obtain Hety approval before executing a model-supplied command. */
export async function executeServerCommand(server: Server, script: string, sudo: boolean, signal: AbortSignal): Promise<RemoteExec & { truncated: boolean }> {
  if (!script.trim() || script.length > 64000 || script.includes('\0')) throw new Error('Invalid server command.')
  if (signal.aborted) throw new Error('Run stopped.')
  const client = new Client()
  client.on('error', () => undefined) // Active operations handle errors; absorb late teardown events.
  const abort = (): void => { client.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  const execute = (command: string, stdin?: string): Promise<RemoteExec & { truncated: boolean }> => new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined
    let stdout = '', stderr = '', truncated = false, settled = false, stdoutBytes = 0
    const finish = (error?: Error, code = 0): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancelled)
      client.removeListener('error', connectionError)
      client.removeListener('close', closed)
      if (error) reject(error); else resolve({ code, stdout, stderr, truncated })
    }
    const cancelled = (): void => { channel?.close(); finish(new Error('Run stopped.')) }
    const connectionError = (error: Error): void => finish(error)
    const closed = (): void => finish(new Error('SSH connection closed during inspection.'))
    const timer = setTimeout(() => { channel?.close(); finish(new Error('SSH inspection timed out after 45 seconds.')) }, 45_000)
    signal.addEventListener('abort', cancelled, { once: true })
    client.once('error', connectionError)
    client.once('close', closed)
    client.exec(command, { pty: false }, (error, stream) => {
      if (error) { finish(error); return }
      channel = stream
      if (settled || signal.aborted) { stream.close(); finish(new Error('Run stopped.')); return }
      stream.setEncoding('utf8')
      stream.stderr.setEncoding('utf8')
      stream.on('data', (text: string) => {
        const buffer = Buffer.from(text, 'utf8')
        const remaining = 131072 - stdoutBytes
        const part = buffer.subarray(0, Math.max(0, remaining))
        stdout += part.toString('utf8')
        stdoutBytes += part.length
        if (buffer.length > remaining) { truncated = true; stream.close() }
      })
      stream.stderr.on('data', (text: string) => { stderr = (stderr + text).slice(-8192) })
      stream.on('error', (err: Error) => finish(err))
      stream.on('close', (code: number | null) => finish(undefined, code ?? -1))
      stream.end(stdin)
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { client.destroy(); finish(new Error('SSH connection timed out.')) }, 20_000)
      const cancelled = (): void => finish(new Error('Run stopped.'))
      const failed = (error: Error): void => finish(error)
      const closed = (): void => finish(new Error('SSH connection closed.'))
      const ready = (): void => finish()
      const finish = (error?: Error): void => {
        clearTimeout(timeout)
        client.removeListener('ready', ready)
        client.removeListener('error', failed)
        client.removeListener('close', closed)
        signal.removeEventListener('abort', cancelled)
        if (error) reject(error); else resolve()
      }
      client.once('ready', ready)
      client.once('error', failed)
      client.once('close', closed)
      client.on('keyboard-interactive', (_name, _instructions, _language, _prompts, reply) => reply([server.password ?? '']))
      signal.addEventListener('abort', cancelled, { once: true })
      try { client.connect(connectConfig(server)) } catch (error) { finish(error as Error) }
    })
    if (signal.aborted) throw new Error('Run stopped.')
    const command = `sh -c ${q(script)}`
    if (!sudo || server.username === 'root') return await execute(command)
    const result = await execute(`sudo -n -- ${command}`)
    if (result.code === 0 || !/password is required|no tty present|a terminal is required|askpass/i.test(result.stderr)) return result
    const password = server.sudoPassword || server.password
    if (!password) throw new Error('This inspection requires sudo. Set the server’s sudo password in Hety.')
    return await execute(`sudo -S -p '' -- ${command}`, `${password}\n`)
  } finally {
    signal.removeEventListener('abort', abort)
    client.end()
    client.destroy()
  }
}
