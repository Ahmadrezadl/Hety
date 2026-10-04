import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import type { CodexStatus } from '@shared/codex'

export interface CodexLauncher { command: string; prefix: string[]; executable: string }

async function launcherAt(candidate: string): Promise<CodexLauncher | null> {
  try {
    if (!(await fs.stat(candidate)).isFile()) return null
    const extension = path.extname(candidate).toLowerCase()
    if (extension === '.cmd' || extension === '.ps1') {
      // npm's Windows shims cannot be spawned directly. Run the package entry
      // with Electron's bundled Node instead of interpolating shell commands.
      return launcherAt(path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
    }
    if (extension === '.js') {
      // Launch the native binary directly. npm's JS wrapper spawns it without
      // windowsHide, which otherwise flashes a console on every status probe.
      const realEntry = await fs.realpath(candidate)
      const target = process.platform === 'win32' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc` : null
      if (target) {
        const packageRoot = path.dirname(path.dirname(realEntry))
        const vendorRoots = [path.join(packageRoot, 'vendor')]
        try {
          const pkg = createRequire(realEntry).resolve(`@openai/codex-win32-${process.arch}/package.json`)
          vendorRoots.unshift(path.join(path.dirname(pkg), 'vendor'))
        } catch { /* Older installations bundle vendor beside bin. */ }
        for (const vendor of vendorRoots) {
          for (const directory of ['bin', 'codex']) {
            const native = await launcherAt(path.join(vendor, target, directory, 'codex.exe'))
            if (native) return native
          }
        }
      }
      return { command: process.execPath, prefix: [candidate], executable: candidate }
    }
    if (process.platform !== 'win32') await fs.access(candidate, constants.X_OK)
    return { command: candidate, prefix: [], executable: candidate }
  } catch { return null }
}

export async function findCodex(): Promise<CodexLauncher | null> {
  const folders = (process.env.PATH ?? '').split(path.delimiter)
  if (process.platform === 'win32' && process.env.APPDATA) folders.push(path.join(process.env.APPDATA, 'npm'))
  folders.push(path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.ps1'] : ['codex']
  for (const folder of [...new Set(folders.filter(Boolean))]) {
    for (const name of names) {
      const launcher = await launcherAt(path.join(folder.replace(/^"|"$/g, ''), name))
      if (launcher) return launcher
    }
  }
  return null
}

export function spawnCodex(launcher: CodexLauncher, args: string[], cwd?: string): ChildProcessWithoutNullStreams {
  return spawn(launcher.command, [...launcher.prefix, ...args], {
    cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(launcher.prefix.length ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
  })
}

export function stopCodex(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false })
    killer.on('error', () => { child.kill() })
  } else {
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') }
    catch { child.kill('SIGTERM') }
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
    }, 2000)
    timer.unref()
  }
}

/** Disable inherited tools that could write without Hety's approval gate. */
export async function codexIsolationArgs(launcher: CodexLauncher, cwd: string): Promise<string[]> {
  const servers = await new Promise<{name:string;type:string}[]>((resolve,reject) => {
    const child=spawnCodex(launcher,['-c','mcp_servers={}','mcp','list','--json'],cwd)
    let output=''
    const timer=setTimeout(() => {stopCodex(child);reject(new Error('Could not inspect Codex tool configuration.'))},10000)
    child.stdin.end()
    child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string) => {output+=chunk;if(output.length>1000000){stopCodex(child);reject(new Error('Codex tool configuration is too large.'))}})
    child.once('error',() => {clearTimeout(timer);reject(new Error('Could not inspect Codex tool configuration.'))})
    child.once('close',(code) => {
      clearTimeout(timer)
      try {
        if(code!==0)throw new Error()
        const items=JSON.parse(output)
        if(!Array.isArray(items) || items.some((item) => typeof item.name!=='string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(item.name) || !['stdio','streamable_http'].includes(item.transport?.type)))throw new Error()
        resolve(items.filter((item) => item.name!=='hety').map((item) => ({name:item.name,type:item.transport.type})))
      } catch {reject(new Error('Cannot isolate Codex tools for this run. Check the Codex MCP configuration.'))}
    })
  })
  return [
    '-c', 'mcp_servers={}',
    // A bare enabled=false table can be rejected as an invalid transport by
    // desktop-managed CLI configs. Supply a complete, inert disabled transport.
    ...servers.flatMap(({name,type}) => ['-c',`mcp_servers.${name}={enabled=false,${type==='stdio' ? 'command="hety-tool-disabled",args=[]' : 'url="http://127.0.0.1:1/disabled"'}}`]),
    ...['shell_tool','apps','plugins','hooks','browser_use','browser_use_external','computer_use','skill_mcp_dependency_install','image_generation'].flatMap((name) => ['-c',`features.${name}=false`])
  ]
}

function probe(launcher: CodexLauncher, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnCodex(launcher, args)
    let output = ''
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-8192) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.stdin.end()
    const timer = setTimeout(() => {
      stopCodex(child)
      reject(new Error('Codex did not respond within 10 seconds.'))
    }, 10_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: output.trim() }) })
  })
}

let checking: Promise<CodexStatus> | null = null
let cached: { status: CodexStatus; at: number } | null = null
export function checkCodex(force = false): Promise<CodexStatus> {
  if (checking) return checking
  if (!force && cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.status)
  checking = (async () => {
    const launcher = await findCodex()
    if (!launcher) return {
      installed: false, authenticated: false,
      message: 'Install Codex CLI with npm install -g @openai/codex, then run codex login in a terminal.'
    }
    try {
      const version = await probe(launcher, ['--version'])
      if (version.code !== 0) throw new Error(version.output || 'Codex could not start.')
      const auth = await probe(launcher, ['login', 'status'])
      return {
        installed: true, authenticated: auth.code === 0,
        version: version.output, executable: launcher.executable,
        message: auth.code === 0 ? undefined : 'Run codex login in a terminal, then check again.'
      }
    } catch (error) {
      return { installed: true, authenticated: false, executable: launcher.executable, message: (error as Error).message }
    }
  })().then((status) => { cached = { status, at: Date.now() }; return status }).finally(() => { checking = null })
  return checking
}
