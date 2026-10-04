const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')
const ts = require('typescript')
const connections = []
const commands = []
let behavior = 'read'

class FakeClient extends EventEmitter {
  connect(config) { connections.push(config); queueMicrotask(() => behavior === 'connection-error' ? this.emit('error', new Error('SSH failed')) : this.emit('ready')); return this }
  exec(command, _options, callback) {
    commands.push({ command })
    const stream = new EventEmitter()
    stream.stderr = new EventEmitter()
    stream.setEncoding = stream.stderr.setEncoding = () => {}
    stream.close = () => queueMicrotask(() => stream.emit('close', null))
    stream.end = (stdin) => {
      commands.at(-1).stdin = stdin
      queueMicrotask(() => {
        if (behavior === 'hang') return
        if (command.startsWith('sudo -n')) { stream.stderr.emit('data', 'sudo: a password is required'); stream.emit('close', 1); return }
        stream.emit('data', behavior === 'large' ? 'x'.repeat(150000) : 'DB_NAME=prod\nDB_PASSWORD=discovered')
        stream.emit('close', 0)
      })
    }
    callback(null, stream)
  }
  end() { return this }
  destroy() { queueMicrotask(() => this.emit('close')); return this }
}
const root = path.resolve(__dirname, '..')
const originalLoad = Module._load
Module._load = function (name, parent, ...rest) {
  if (name === 'ssh2') return { Client: FakeClient }
  if (name === 'electron') return {}
  if (name.startsWith('@shared/')) name = path.join(root, 'src/shared', name.slice(8) + '.ts')
  return originalLoad.call(this, name, parent, ...rest)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename)
const { inspectServer, inspectionScript } = require('../src/main/lib/codexSsh.ts')
const server = {id:'server',name:'Production',host:'production.example',port:22,username:'deploy',authType:'password',password:'SAVED_SSH_PASSWORD',sudoPassword:'SAVED_SUDO_PASSWORD'}

test('SSH inspection uses saved authentication internally and returns only the remote output', async () => {
  behavior = 'read'
  const result = await inspectServer(server, {operation:'read_file',path:'/var/www/app/.env'}, new AbortController().signal)
  assert.equal(connections.at(-1).password, 'SAVED_SSH_PASSWORD')
  assert.equal(connections.at(-1).host, 'production.example')
  assert.ok(result.stdout.includes('discovered'))
  assert.ok(!JSON.stringify(result).includes('SAVED_SSH_PASSWORD'))
  assert.equal(result.code, 0)
})
test('sudo authentication travels through stdin, not command text or tool output', async () => {
  behavior = 'read'
  const result = await inspectServer(server, {operation:'read_file',path:'/etc/app/.env',sudo:true}, new AbortController().signal)
  assert.equal(commands.at(-1).stdin, 'SAVED_SUDO_PASSWORD\n')
  assert.ok(!commands.at(-1).command.includes('SAVED_SUDO_PASSWORD'))
  assert.ok(!JSON.stringify(result).includes('SAVED_SUDO_PASSWORD'))
})
test('path metacharacters remain inside quoted read-only arguments; arbitrary operations are rejected', () => {
  const command = inspectionScript({operation:'read_file',path:"/tmp/'; touch /tmp/unwanted; '"})
  assert.equal(command, "head -c 131072 -- '/tmp/'\\''; touch /tmp/unwanted; '\\''' ".trim())
  assert.throws(() => inspectionScript({operation:'execute',command:'rm -rf /'}))
  assert.throws(() => inspectionScript({operation:'read_file',path:'relative/path'}))
  assert.throws(() => inspectionScript({operation:'docker_config',target:'x; rm -rf /'}))
  assert.throws(() => inspectionScript({operation:'process_environment',target:'x'}))
})
test('large remote output is bounded and marked truncated', async () => {
  behavior = 'large'
  const result = await inspectServer(server, {operation:'docker'}, new AbortController().signal)
  assert.equal(result.stdout.length, 131072)
  assert.equal(result.truncated, true)
})
test('SSH failures and cancellation finish without leaving a running inspection', async () => {
  behavior = 'connection-error'
  await assert.rejects(inspectServer(server, {operation:'overview'}, new AbortController().signal), /SSH failed/)
  behavior = 'hang'
  const controller = new AbortController()
  const inspection = inspectServer(server, {operation:'overview'}, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(inspection, /Run stopped/)
})
