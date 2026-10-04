import type { Pm2Action, Pm2Instance, Pm2Process, Pm2Report, Pm2Scope, RemoteExec } from '@shared/types'
import { q } from './remoteParse'

export type Pm2Exec = (scope: Pm2Scope, script: string) => Promise<RemoteExec>

/** Login shells often omit nvm initialization for non-interactive SSH commands. */
const DISCOVER = [
  'export NO_COLOR=1 FORCE_COLOR=0',
  'if ! command -v pm2 >/dev/null 2>&1; then',
  '  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1; fi',
  '  PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$PATH"; export PATH',
  'fi',
  'hety_pm2=$(command -v pm2 2>/dev/null)',
  'if [ -z "$hety_pm2" ] && [ -n "$HETY_PM2_FALLBACK" ] && [ -x "$HETY_PM2_FALLBACK" ]; then',
  '  hety_pm2="$HETY_PM2_FALLBACK"; PATH="$(dirname "$hety_pm2"):$PATH"; export PATH',
  'fi',
  'if [ -z "$hety_pm2" ]; then echo "@@hety-pm2-missing"; exit 0; fi'
].join('\n')

export const PM2_FIND_SCRIPT = `${DISCOVER}\nprintf '%s\\n' "$hety_pm2"`

export const PM2_LIST_SCRIPT = [
  DISCOVER,
  "echo '@@hety-pm2-meta'",
  'id -un',
  'printf "%s\\n" "${PM2_HOME:-$HOME/.pm2}" "$hety_pm2"',
  "echo '@@hety-pm2-json'",
  '"$hety_pm2" jlist'
].join('\n')

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

/** Strip startup banners, and return only display fields (never process environment secrets). */
export function parsePm2List(output: string): Pm2Process[] {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '').trim()
  let list: unknown
  for (let start = clean.indexOf('['); start >= 0; start = clean.indexOf('[', start + 1)) {
    try { list = JSON.parse(clean.slice(start)); break } catch { /* PM2 startup banners contain [PM2]. */ }
  }
  if (!Array.isArray(list)) throw new Error('PM2 returned an invalid process list')
  return list.map((item) => {
    const p = record(item)
    const env = record(p.pm2_env)
    const monit = record(p.monit)
    if (!Number.isSafeInteger(p.pm_id) || (p.pm_id as number) < 0) throw new Error('PM2 returned an invalid process id')
    return {
      id: p.pm_id as number, pid: num(p.pid), name: str(p.name) || str(env.name),
      namespace: str(env.namespace) || 'default', status: str(env.status) || 'unknown',
      mode: str(env.exec_mode).replace(/_mode$/, ''), cpu: num(monit.cpu), memory: num(monit.memory),
      uptime: num(env.pm_uptime), restarts: num(env.restart_time), script: str(env.pm_exec_path), cwd: str(env.pm_cwd)
    }
  })
}

export function samePm2List(a: Pm2Instance, b: Pm2Instance): boolean {
  if (!a.accessible || !b.accessible) return false
  // CPU/memory change between reads. Names/IDs alone collide across different daemons.
  const identity = (processes: Pm2Process[]): string => JSON.stringify([...processes]
    .sort((x, y) => x.id - y.id)
    .map((p) => [p.id, p.pid, p.name, p.namespace, p.script, p.cwd, p.status]))
  return identity(a.processes) === identity(b.processes)
}

export async function readPm2Instance(exec: Pm2Exec, scope: Pm2Scope): Promise<Pm2Instance> {
  const instance: Pm2Instance = { scope, user: scope, installed: false, accessible: false, home: '', binary: '', processes: [] }
  try {
    const res = await exec(scope, PM2_LIST_SCRIPT)
    const meta = res.stdout.split('@@hety-pm2-meta\n')[1]?.split('\n')
    if (meta) {
      instance.installed = true
      instance.user = meta[0]?.trim() || scope
      instance.home = meta[1]?.trim() || ''
      instance.binary = meta[2]?.trim() || ''
    }
    if (res.code !== 0) throw new Error(res.stderr.trim() || `PM2 exited with ${res.code}`)
    if (res.stdout.includes('@@hety-pm2-missing')) return instance
    if (!meta) throw new Error('Could not detect PM2 on this account')
    instance.processes = parsePm2List(res.stdout.split('@@hety-pm2-json\n')[1] ?? '')
    instance.accessible = true
  } catch (e) {
    instance.message = e instanceof Error ? e.message : String(e)
  }
  return instance
}

export async function readPm2(exec: Pm2Exec, isRoot: boolean, canSudo: boolean): Promise<Pm2Report> {
  const user = await readPm2Instance(exec, isRoot ? 'root' : 'user')
  const instances = [user]
  if (!isRoot && canSudo) instances.push(await readPm2Instance(exec, 'root'))
  const sameList = instances.length === 2 && samePm2List(instances[0], instances[1])
  return { installed: instances.some((i) => i.installed), instances: sameList ? [user] : instances, sameList }
}

export function pm2Command(scope: Pm2Scope, action: Pm2Action | 'logs' | 'save', id?: number, lines = 300): string {
  if (!['user', 'root'].includes(scope)) throw new Error('Invalid PM2 account')
  if (!['restart', 'reload', 'stop', 'delete', 'logs', 'save'].includes(action)) throw new Error('Unsupported PM2 action')
  if (action !== 'save' && (!Number.isSafeInteger(id) || (id as number) < 0)) throw new Error('Invalid PM2 process id')
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 2000) throw new Error('Log line count must be between 1 and 2000')
  const args = action === 'save' ? 'save' : action === 'logs' ? `logs ${id} --lines ${lines} --nostream` : `${action} ${id}`
  return `${DISCOVER.replace('exit 0', 'exit 127')}\n"$hety_pm2" ${args} --no-color`
}

/** Strict sudo: a root operation must never fall back to the SSH user's daemon. */
export async function execPm2Root(
  exec: (command: string, input?: string) => Promise<RemoteExec>,
  script: string,
  secret?: string
): Promise<RemoteExec> {
  const command = `-H -u root -- env -u PM2_HOME sh -lc ${q(script)}`
  let res = await exec(`sudo -n ${command}`)
  if (res.code !== 0 && /password is required|no tty present|a terminal is required|askpass/i.test(res.stderr) && secret) {
    res = await exec(`sudo -S -p '' ${command}`, `${secret}\n`)
  }
  if (res.code !== 0 && /sudo:|incorrect password|Sorry, try again/i.test(res.stderr)) {
    throw new Error('Could not access root PM2: sudo was refused. Check the server’s sudo password and permissions.')
  }
  return res
}
