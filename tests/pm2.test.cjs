const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')

const handlers = new Map()
const commands = []
let rootDenied = false
let missing = false
class FakeClient extends EventEmitter {
  connect(config) { this.config = config; queueMicrotask(() => this.emit('ready')); return this }
  exec(command, _options, callback) {
    const call = { command, input: '' }
    commands.push(call)
    const stream = new EventEmitter()
    stream.stderr = new EventEmitter()
    stream.write = (input) => { call.input += input }
    stream.close = () => stream.emit('close', 1)
    stream.end = () => queueMicrotask(() => {
      let stdout = '', stderr = '', code = 0
      if (command.startsWith('sudo -n')) { stderr = 'sudo: a password is required'; code = 1 }
      else if (command.startsWith('sudo -S') && rootDenied) { stderr = 'Sorry, try again.\nsudo: incorrect password'; code = 1 }
      else if (command.includes('"$hety_pm2" jlist')) {
        const root = command.startsWith('sudo') || this.config.username === 'root'
        stdout = missing ? '@@hety-pm2-missing\n' : listing(root ? 'root' : 'deploy', root ? 802 : 801)
      } else if (command.includes('"$hety_pm2" restart')) {
        if (missing) { stdout = '@@hety-pm2-missing\n'; code = 127 }
        else stdout = 'Restarted'
      } else if (command.includes('"$hety_pm2" logs')) stdout = 'last log lines'
      else if (command.includes('"$hety_pm2" save')) stdout = 'Saved'
      else if (command.includes('hety_pm2=$(command -v pm2')) stdout = '/home/deploy/.nvm/versions/node/v22/bin/pm2\n'
      else stdout = `${this.config.username}\n${this.config.username === 'root' ? '0' : '1000'}\n/home/deploy\nserver\n6.1\nLinux\n/bin/bash\nyes\n`
      if (stdout) stream.emit('data', Buffer.from(stdout))
      if (stderr) stream.stderr.emit('data', Buffer.from(stderr))
      stream.emit('close', code)
    })
    callback(null, stream)
  }
  end() { return this }
}
const projectRoot = path.resolve(__dirname, '..')
const originalLoad = Module._load
Module._load = function (name, parent, ...rest) {
  if (name === 'ssh2') return { Client: FakeClient }
  if (name === 'electron') return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, BrowserWindow: { getAllWindows: () => [] }, dialog: {} }
  if (name.startsWith('@shared/')) name = path.join(projectRoot, 'src/shared', name.slice(8) + '.ts')
  return originalLoad.call(this, name, parent, ...rest)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText, filename)
const { parsePm2List, readPm2, samePm2List, pm2Command, execPm2Root } = require('../src/main/lib/pm2.ts')
require('../src/main/ipc/ops.ts').registerOpsIpc()

function processData(pid = 801) {
  return { pm_id: 0, pid, name: 'api', monit: { cpu: 3.2, memory: 123456 },
    pm2_env: { status: 'online', exec_mode: 'cluster_mode', namespace: 'production', restart_time: 2,
      pm_uptime: 10000, pm_exec_path: '/srv/api/server.js', pm_cwd: '/srv/api', SECRET: 'private-env' } }
}
function listing(user, pid = 801, processes = [processData(pid)]) {
  return `@@hety-pm2-meta\n${user}\n/${user}/.pm2\n/usr/local/bin/pm2\n@@hety-pm2-json\n[PM2] Spawning daemon...\n${JSON.stringify(processes)}\n`
}
const success = (stdout) => ({ code: 0, stdout, stderr: '' })

test('PM2 startup banners parse without exposing environment variables', () => {
  const processes = parsePm2List('[PM2] Daemon started\n' + JSON.stringify([processData()]))
  assert.equal(processes[0].id, 0)
  assert.equal(processes[0].mode, 'cluster')
  assert.equal(processes[0].memory, 123456)
  assert.ok(!JSON.stringify(processes).includes('private-env'))
  assert.deepEqual(parsePm2List('[PM2] Started\n[]'), [])
  assert.throws(() => parsePm2List('not JSON'), /invalid process list/)
  assert.throws(() => parsePm2List('[{"pm_id": "all"}]'), /invalid process id/)
})

test('sudo lists user and root separately even when PM2 IDs and names collide', async () => {
  const scopes = []
  const report = await readPm2(async (scope) => { scopes.push(scope); return success(listing(scope, scope === 'root' ? 802 : 801)) }, false, true)
  assert.deepEqual(scopes, ['user', 'root'])
  assert.equal(report.instances.length, 2)
  assert.equal(report.sameList, false)
  assert.equal(report.instances[1].processes[0].pid, 802)
})

test('identical lists deduplicate despite changing CPU/memory and order', async () => {
  const list = [processData(801), { ...processData(803), pm_id: 1 }]
  const report = await readPm2(async (scope) => success(listing(scope, 0, scope === 'user' ? list :
    [...list].reverse().map((p) => ({ ...p, monit: { cpu: 99, memory: 999999 } })))), false, true)
  assert.equal(report.sameList, true)
  assert.equal(report.instances.length, 1)
  assert.equal(report.instances[0].scope, 'user')
  const empty = await readPm2(async (scope) => success(listing(scope, 0, [])), false, true)
  assert.equal(empty.sameList, true)
})

test('root failures preserve user data; a root-only install works when user PM2 is absent', async () => {
  const denied = await readPm2(async (scope) => { if (scope === 'root') throw new Error('sudo refused'); return success(listing('deploy')) }, false, true)
  assert.equal(denied.installed, true)
  assert.equal(denied.instances[0].accessible, true)
  assert.match(denied.instances[1].message, /sudo refused/)
  const rootOnly = await readPm2(async (scope) => success(scope === 'root' ? listing('root') : '@@hety-pm2-missing\n'), false, true)
  assert.equal(rootOnly.installed, true)
  assert.equal(rootOnly.instances[0].installed, false)
  assert.equal(rootOnly.instances[1].accessible, true)
  assert.equal(samePm2List(denied.instances[0], denied.instances[1]), false)
})

test('root login queries once; unprivileged accounts do not probe root without sudo', async () => {
  for (const [isRoot, canSudo, scope] of [[true, true, 'root'], [false, false, 'user']]) {
    const scopes = []
    const report = await readPm2(async (s) => { scopes.push(s); return success(listing(s)) }, isRoot, canSudo)
    assert.deepEqual(scopes, [scope])
    assert.equal(report.instances[0].scope, scope)
  }
})

test('process actions reject injection and logs are bounded without streaming', () => {
  for (const action of ['restart', 'reload', 'stop', 'delete']) assert.match(pm2Command('user', action, 0), new RegExp(`${action} 0 --no-color`))
  assert.match(pm2Command('root', 'logs', 4, 300), /logs 4 --lines 300 --nostream/)
  assert.match(pm2Command('root', 'save'), /"\$hety_pm2" save/)
  assert.match(pm2Command('user', 'restart', 0), /exit 127/)
  for (const id of ['all', '0; rm -rf /', -1, 0.5, NaN]) assert.throws(() => pm2Command('user', 'stop', id))
  assert.throws(() => pm2Command('other', 'stop', 0))
  assert.throws(() => pm2Command('user', 'kill', 0))
  assert.throws(() => pm2Command('user', 'logs', 0, 3000))
})

test('sudo secrets go through stdin and root always uses root HOME without inherited PM2_HOME', async () => {
  const calls = []
  const result = await execPm2Root(async (command, input) => {
    calls.push({ command, input })
    return calls.length === 1 ? { code: 1, stdout: '', stderr: 'sudo: a password is required' } : success('root processes')
  }, 'pm2 jlist', 'SUDO_SECRET')
  assert.equal(result.stdout, 'root processes')
  assert.equal(calls[1].input, 'SUDO_SECRET\n')
  assert.ok(calls.every((c) => !c.command.includes('SUDO_SECRET')))
  assert.match(calls[1].command, /-H -u root -- env -u PM2_HOME sh -lc/)
  const refused = []
  await assert.rejects(execPm2Root(async (command) => {
    refused.push(command); return { code: 1, stdout: '', stderr: 'sudo: user is not allowed to execute this command' }
  }, 'pm2 stop 0', 'secret'), /sudo was refused/)
  assert.equal(refused.length, 1)
  assert.ok(refused.every((c) => c.startsWith('sudo')))
})

const server = { id: 'pm2-server', name: 'Server', host: 'example.test', port: 22, username: 'deploy', authType: 'password', password: 'SSH_SECRET', sudoPassword: 'SUDO_SECRET' }
const invoke = (channel, args = {}) => handlers.get(channel)(null, { server, ...args })
test('remote IPC loads both accounts, uses saved sudo credentials, and targets root actions/logs/save', async () => {
  const report = await invoke('ops:pm2')
  assert.equal(report.ok, true)
  assert.deepEqual(report.data.instances.map((i) => i.scope), ['user', 'root'])
  const rootList = commands.find((c) => c.command.startsWith('sudo -S') && c.command.includes('"$hety_pm2" jlist'))
  assert.equal(rootList.input, 'SUDO_SECRET\n')
  assert.match(rootList.command, /HETY_PM2_FALLBACK=/)
  assert.ok(!rootList.command.includes('SUDO_SECRET'))
  assert.ok(!JSON.stringify(report).includes('private-env'))
  assert.equal((await invoke('ops:pm2Action', { scope: 'root', action: 'restart', id: 0 })).ok, true)
  assert.match(commands.at(-1).command, /^sudo -S/)
  assert.match(commands.at(-1).command, /restart 0/)
  assert.equal((await invoke('ops:pm2Logs', { scope: 'root', id: 0 })).data, 'last log lines')
  assert.match(commands.at(-1).command, /--nostream/)
  assert.equal((await invoke('ops:pm2Save', { scope: 'user' })).data, 'Saved')
  assert.ok(!commands.at(-1).command.startsWith('sudo'))
})

test('remote IPC returns root errors without executing user actions and rejects invalid arguments before execution', async () => {
  rootDenied = true
  const report = await invoke('ops:pm2')
  assert.equal(report.data.instances[0].accessible, true)
  assert.match(report.data.instances[1].message, /sudo was refused/)
  const start = commands.length
  const action = await invoke('ops:pm2Action', { scope: 'root', action: 'restart', id: 0 })
  assert.equal(action.ok, false)
  assert.ok(commands.slice(start).every((c) => c.command.startsWith('sudo')))
  rootDenied = false
  const before = commands.length
  assert.equal((await invoke('ops:pm2Action', { scope: 'root', action: 'kill', id: 0 })).ok, false)
  assert.equal((await invoke('ops:pm2Action', { scope: 'root', action: 'stop', id: 'all' })).ok, false)
  assert.equal(commands.length, before)
  missing = true
  assert.equal((await invoke('ops:pm2Action', { scope: 'user', action: 'restart', id: 0 })).ok, false)
  missing = false
})
