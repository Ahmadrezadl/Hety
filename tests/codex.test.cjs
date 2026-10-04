const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

// Exercise the real TypeScript IPC and child-process adapter with a local fake
// CLI. This never sends a prompt to OpenAI or reads the user's Hety vault.
const root = path.resolve(__dirname, '..')
const handlers = new Map()
const app = new EventEmitter()
let data
let userDataPath
let writes = 0
let failFlush = false
const inspections = []
const databaseInspections = []
const approvedActions = []
const proposedActions = []
const localInspections = []
app.getPath = () => userDataPath
const electron = { app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }
const originalLoad = Module._load
Module._load = function (name, parent, ...rest) {
  if (name === 'electron') return electron
  if (name === '../lib/codexActions' && parent.filename.endsWith(path.join('ipc','codex.ts'))) return {
    inspectLocal:async (cwd,input) => {localInspections.push({cwd,input});return {content:'read-only'}},
    prepareAction:async (kind,input,context) => {
      if(kind==='database_write' && !context.permissions.databaseWrites)throw new Error('Write requests are disabled.')
      proposedActions.push({kind,input,context})
      return {review:{kind,title:kind,target:'Production',reason:input.reason,details:input.sql ?? input.body ?? 'file',warning:'Changes data',language:'sql'},execute:async (signal) => {
        assert.equal(signal.aborted,false)
        approvedActions.push({kind,input})
        if(input.reason==='fail')throw new Error('Synthetic write failure')
        return {executed:true,success:true,affectedRows:1}
      }}
    }
  }
  if (name === '../lib/codexDb' && parent.filename.endsWith(path.join('ipc', 'codex.ts'))) return { inspectDatabase: async (db, server, input, signal) => {
    databaseInspections.push({ db, server, input, signal })
    return input.sql ? { columns:['count','min','max','median','average'], rows:[[1001,1,1000,5,6]], readOnly:true, truncated:false } : { schemas:[{name:'public',tables:[{name:'scores',columns:[{name:'score',type:'numeric'},{name:'submitted_at',type:'timestamp'}]}]}] }
  } }
  if (name === '../lib/store' && parent.filename.endsWith(path.join('ipc', 'codex.ts'))) return { getData: () => data, save: async (next) => { data = next; writes++ }, flush: async () => { if (failFlush) { failFlush = false; throw new Error('Synthetic disk failure') } } }
  if (name === '../lib/codexSsh' && parent.filename.endsWith(path.join('ipc', 'codex.ts'))) return { inspectServer: async (server, input) => {
    inspections.push({ server, input })
    return { code: 0, stdout: 'DB_NAME=production\nDB_USER=produser\nDB_PASSWORD=DISCOVERED_PASSWORD', stderr: '', truncated: false }
  } }
  if (name.startsWith('@shared/')) name = path.join(root, 'src/shared', name.slice('@shared/'.length) + '.ts')
  return originalLoad.call(this, name, parent, ...rest)
}
require.extensions['.ts'] = (module, filename) => {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  })
  module._compile(source.outputText, filename)
}
const { projectCodexContext, buildCodexPrompt, hasCurrentHetyTools, HETY_CODEX_INTEGRATION_VERSION, HETY_REQUIRED_TOOLS } = require('../src/shared/codex.ts')
const {defaultCodexAccess, resolveCodexAccess, actionAccessMode, scopedCodexProject} = require('../src/shared/codexAccess.ts')
const { checkCodex, findCodex } = require('../src/main/lib/codex.ts')
const { startHetyBridge } = require('../src/main/lib/hetyMcp.ts')
require('../src/main/ipc/codex.ts').registerCodexIpc()

class Owner extends EventEmitter {
  constructor(id) { super(); this.id = id; this.events = [] }
  isDestroyed() { return false }
  send(channel, event) { assert.equal(channel, 'codex:event'); this.events.push(event); this.emit('output', event) }
}
function done(owner, runId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { owner.removeListener('output', listener); reject(new Error('Timed out waiting for Codex')) }, 8000)
    const listener = (event) => {
      if (event.runId === runId && event.type === 'done') { clearTimeout(timer); owner.removeListener('output', listener); resolve(event) }
    }
    owner.on('output', listener)
  })
}
function approvalFor(owner, runId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { owner.removeListener('output', listener); reject(new Error('Timed out waiting for proposal')) }, 8000)
    const listener = (event) => {
      if (event.runId === runId && event.type === 'approval' && event.approval) { clearTimeout(timer); owner.removeListener('output', listener); resolve(event.approval) }
    }
    owner.on('output', listener)
  })
}
function writeApprovalFor(owner,runId) {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(() => {owner.removeListener('output',listener);reject(new Error('Timed out waiting for write approval'))},8000)
    const listener=(event) => {if(event.runId===runId && event.type==='approval' && event.writeApproval){clearTimeout(timer);owner.removeListener('output',listener);resolve(event.writeApproval)}}
    owner.on('output',listener)
  })
}

test('Codex project integration', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hety-codex-'))
  userDataPath = path.join(temporary, 'userdata')
  const originalEnv = { ...process.env }
  const originalHomedir = os.homedir
  os.homedir = () => temporary
  t.after(() => {
    os.homedir = originalHomedir
    app.emit('before-quit')
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
    Object.assign(process.env, originalEnv)
    fs.rmSync(temporary, { recursive: true, force: true })
  })
  const npm = path.join(temporary, 'npm')
  const entry = path.join(npm, 'node_modules/@openai/codex/bin/codex.js')
  const capture = path.join(temporary, 'capture.json')
  const cwd = path.join(temporary, 'repo with spaces & symbols')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.mkdirSync(cwd)
  const fakeCli = `
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('codex-cli test'); process.exit(0) }
if (args[0] === 'login') { console.error(process.env.HETY_FAKE_MODE === 'unauth' ? 'Not logged in' : 'Logged in'); process.exit(process.env.HETY_FAKE_MODE === 'unauth' ? 1 : 0) }
if (args.includes('mcp') && args.includes('list')) { console.log(JSON.stringify([{name:'outside_tool',enabled:true,transport:{type:'stdio'}},{name:'outside_http',enabled:true,transport:{type:'streamable_http'}}]));process.exit(0) }
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => prompt += chunk)
process.stdin.on('end', async () => {
  fs.writeFileSync(process.env.HETY_CODEX_CAPTURE, JSON.stringify({ args, prompt, cwd: process.cwd() }))
  if (process.env.HETY_FAKE_MODE === 'hang') { setInterval(() => {}, 1000); return }
  if (process.env.HETY_FAKE_MODE === 'fail') { console.error('Synthetic authentication failure'); process.exit(1) }
  if (process.env.HETY_FAKE_MODE !== 'no-tools') {
    const config = args.find(arg => arg.startsWith('mcp_servers.hety='))
    const url = JSON.parse(config.match(/url=("[^"]+")/)[1])
    let id = 0
    const rpc = async (method, params) => (await (await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})})).json()).result
    await rpc('initialize', {protocolVersion:'2025-03-26',clientInfo:{name:'fake-codex',version:'1'},capabilities:{}})
    await rpc('tools/list')
    if (process.env.HETY_FAKE_MODE === 'local-read' || process.env.HETY_FAKE_MODE === 'local-write') {
      const result = await rpc('tools/call',{name:process.env.HETY_FAKE_MODE==='local-read' ? 'local_inspect' : 'local_write',arguments:{repositoryId:'repo',operation:'read_file',path:'README.md',content:'Synthetic content',reason:'Synthetic local task'}})
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result.content[0].text}}));return
    }
    if (['write','read-http'].includes(process.env.HETY_FAKE_MODE)) {
      const arguments = process.env.HETY_FAKE_MODE==='read-http' ? {url:'https://example.test/read',method:'GET',reason:'Read records'} : {databaseId:'db',sql:"UPDATE scores SET banner = 'approved' WHERE id = 7",reason:process.env.HETY_WRITE_REASON || 'Update banner'}
      const result=await rpc('tools/call',{name:process.env.HETY_FAKE_MODE==='read-http' ? 'http_request' : 'database_write',arguments})
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result.content[0].text}}));return
    }
    if (process.env.HETY_FAKE_MODE === 'database') {
      const context = JSON.parse((await rpc('tools/call', {name:'get_project',arguments:{}})).content[0].text)
      const databaseId = context.databases[0].id
      await rpc('tools/call', {name:'database_schema',arguments:{databaseId}})
      const result = await rpc('tools/call', {name:'database_query',arguments:{databaseId,sql:'SELECT COUNT(*), MIN(score), MAX(score), AVG(score), percentile_cont(0.5) WITHIN GROUP (ORDER BY score) FROM public.scores WHERE submitted_at IS NOT NULL AND score IS NOT NULL'}})
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result.content[0].text}})); return
    }
    if (process.env.HETY_FAKE_MODE === 'inspect') {
      const result = await rpc('tools/call', {name:'ssh_inspect',arguments:{serverId:'server',operation:'read_file',path:'/var/www/app/.env'}})
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result.content[0].text}})); return
    }
    if (process.env.HETY_FAKE_MODE === 'propose') {
      const result = await rpc('tools/call', {name:'propose_database',arguments:{name:'Production database',kind:'postgresql',host:'127.0.0.1',port:5432,database:'production',username:'produser',password:'DISCOVERED_PASSWORD',useSsh:true,sshServerId:'server',source:'Server: /var/www/app/.env'}})
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result.content[0].text}})); return
    }
  }
  console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'git status' } }))
  const output = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Project response ✓ پاسخ' } }))
  // Split JSON and a multibyte codepoint between chunks; omit the final newline.
  const split = output.indexOf(Buffer.from('✓')) + 1
  process.stdout.write(output.subarray(0, split))
  setTimeout(() => process.stdout.write(output.subarray(split)), 30)
})`
  fs.writeFileSync(entry, fakeCli)
  if (process.platform === 'win32') fs.writeFileSync(path.join(npm, 'codex.cmd'), '@echo off')
  else fs.writeFileSync(path.join(npm, 'codex'), '#!' + process.execPath + '\n' + fakeCli, { mode: 0o755 })
  process.env.PATH = npm
  process.env.APPDATA = temporary
  process.env.HETY_CODEX_CAPTURE = capture
  process.env.HETY_FAKE_MODE = 'success'

  const project = {
    id: 'project-a', name: 'Project A', description: 'App', group: 'Development', tags: ['app'],
    repositories: [{ id: 'repo', name: 'Repository', path: cwd }],
    databases: [{ id: 'db', name: 'DB', kind: 'postgres', host: 'localhost', port: 5432, database: 'app', username: 'user', password: 'DB_SECRET', useSsh: true, sshServerId: 'server', locked: true }],
    servers: [{ id: 'server', name: 'Server', host: 'host.example', port: 22, username: 'dev', authType: 'key', password: 'SSH_SECRET', sudoPassword: 'SUDO_SECRET', keyPath: 'PRIVATE_KEY_PATH', keyPassphrase: 'KEY_SECRET', snippets: [{ command: 'SNIPPET_SECRET' }] }],
    board: { columns: [{ name: 'Todo', cards: [{ title: 'Task', description: 'Task details' }] }] },
    createdAt: 0, lastOpenedAt: 0
  }
  data = { projects: [project, { ...project, id: 'project-b', name: 'OTHER_PROJECT_SECRET' }] }
  const owner = new Owner(1)
  const request = (runId, extra = {}) => ({ runId, projectId: project.id, repositoryId: 'repo', prompt: 'Explain this project', history: [], allowEdits: false, ...extra })
  const start = (req, sender = owner) => handlers.get('codex:start')({ sender }, req)

  await t.test('detects the installed CLI and authentication through its Windows npm shim', async () => {
    const status = await checkCodex(true)
    assert.equal(status.installed, true)
    assert.equal(status.authenticated, true)
    assert.equal(status.version, 'codex-cli test')
  })
  await t.test('reports missing authentication independently of installation', async () => {
    process.env.HETY_FAKE_MODE = 'unauth'
    const status = await checkCodex(true)
    assert.equal(status.installed, true)
    assert.equal(status.authenticated, false)
    const result = await start(request('unauth'))
    assert.equal(result.ok, false)
    assert.match(result.error, /login/)
    process.env.HETY_FAKE_MODE = 'success'
    await checkCodex(true)
  })
  await t.test('identifies stale backends and publishes the actual registered tools', async () => {
    assert.equal(hasCurrentHetyTools({installed:true,authenticated:true}), false)
    const status = await handlers.get('codex:status')({sender:owner})
    assert.equal(status.integrationVersion, HETY_CODEX_INTEGRATION_VERSION)
    assert.equal(hasCurrentHetyTools(status), true)
    assert.deepEqual([...status.tools].sort(), [...HETY_REQUIRED_TOOLS].sort())
    assert.equal(hasCurrentHetyTools({...status,tools:status.tools.filter(name=>name!=='database_query')}), false)
  })
  await t.test('fails explicitly when Codex exits successfully without discovering Hety tools', async () => {
    process.env.HETY_FAKE_MODE = 'no-tools'
    const complete = done(owner, 'no-tools')
    assert.equal((await start(request('no-tools'))).ok, true)
    assert.equal((await complete).success, false)
    const events = owner.events.filter(event=>event.runId==='no-tools')
    assert.ok(events.some(event=>event.type==='error' && /did not load Hety/.test(event.text)))
    assert.ok(!events.some(event=>event.type==='message'))
    process.env.HETY_FAKE_MODE = 'success'
  })
  await t.test('context contains only this project and excludes all credential fields', () => {
    const context = JSON.stringify(projectCodexContext(project))
    for (const secret of ['DB_SECRET', 'SSH_SECRET', 'SUDO_SECRET', 'PRIVATE_KEY_PATH', 'KEY_SECRET', 'SNIPPET_SECRET']) assert.ok(!context.includes(secret))
    for (const field of ['Repository', 'host.example', 'postgres', 'Task details']) assert.ok(context.includes(field))
    assert.equal(projectCodexContext(project).databases[0].readOnly, true)
    assert.equal(projectCodexContext({ ...project, databases: [{ ...project.databases[0], locked: undefined }] }).databases[0].readOnly, false)
    const prompt = buildCodexPrompt(project, request('context'), cwd)
    assert.ok(!prompt.includes('OTHER_PROJECT_SECRET'))
  })
  await t.test('streams fragmented Unicode JSON, preserves shell characters through stdin, and uses a read-only sandbox', async () => {
    const prompt = 'Explain "quotes" & $(not_a_command) `literal`\nپرسش'
    const completed = done(owner, 'stream')
    assert.equal((await start(request('stream', { prompt, history: [{ role: 'assistant', text: 'Earlier reply' }] }))).ok, true)
    assert.equal((await completed).success, true)
    assert.equal(owner.events.find((e) => e.runId === 'stream' && e.type === 'message').text, 'Project response ✓ پاسخ')
    const captured = JSON.parse(fs.readFileSync(capture))
    assert.equal(fs.realpathSync.native(captured.cwd), fs.realpathSync.native(cwd))
    assert.equal(captured.args[captured.args.indexOf('--sandbox') + 1], 'read-only')
    assert.ok(captured.prompt.includes(prompt))
    assert.ok(captured.prompt.includes('Earlier reply'))
    assert.ok(!captured.args.includes(prompt))
    assert.ok(!captured.prompt.includes('OTHER_PROJECT_SECRET'))
    const events = owner.events.filter(event=>event.runId==='stream')
    // Tool discovery is separately observable, rather than inferred from a reply.
    const loaded = events.find(event=>event.type==='tools')
    assert.ok(loaded.tools.includes('database_query'))
    assert.ok(events.indexOf(loaded) < events.findIndex(event=>event.type==='message'))
  })
  await t.test('local write requests still use a read-only sandbox and disable tools outside Hety approval', async () => {
    const completed = done(owner, 'edits')
    assert.equal((await start(request('edits', { repositoryId: undefined, folder: cwd, allowEdits: true }))).ok, true)
    assert.equal((await completed).success, true)
    const captured = JSON.parse(fs.readFileSync(capture))
    assert.equal(captured.args[captured.args.indexOf('--sandbox') + 1], 'read-only')
    for(const setting of ['features.shell_tool=false','features.apps=false','features.plugins=false','features.hooks=false','features.browser_use=false','features.computer_use=false','mcp_servers={}','mcp_servers.outside_tool={enabled=false,command="hety-tool-disabled",args=[]}','mcp_servers.outside_http={enabled=false,url="http://127.0.0.1:1/disabled"}'])assert.ok(captured.args.includes(setting))
    assert.ok(captured.args.indexOf('mcp_servers={}')<captured.args.findIndex(arg=>arg.startsWith('mcp_servers.hety=')))
  })
  await t.test('supports Hety prompts without a local folder and disables the local shell in that mode', async () => {
    const completed = done(owner, 'no-folder')
    assert.equal((await start(request('no-folder', { repositoryId: undefined }))).ok, true)
    assert.equal((await completed).success, true)
    const captured = JSON.parse(fs.readFileSync(capture))
    assert.ok(captured.cwd.includes('codex-workspaces'))
    assert.ok(captured.args.includes('features.shell_tool=false'))
    assert.equal((await start(request('no-folder-edits', { repositoryId: undefined, allowEdits: true }))).ok, false)
  })
  await t.test('Codex can inspect a saved SSH server through the scoped Hety tool', async () => {
    process.env.HETY_FAKE_MODE = 'inspect'
    const completed = done(owner, 'ssh-inspect')
    assert.equal((await start(request('ssh-inspect', { repositoryId: undefined }))).ok, true)
    assert.equal((await completed).success, true)
    assert.equal(inspections.at(-1).server.password, 'SSH_SECRET')
    const message = owner.events.find((e) => e.runId === 'ssh-inspect' && e.type === 'message').text
    assert.ok(message.includes('DISCOVERED_PASSWORD'))
    assert.ok(!message.includes('SSH_SECRET'))
    process.env.HETY_FAKE_MODE = 'success'
  })
  await t.test('Codex inspects schema and analyzes a saved database through its SSH server without a folder', async () => {
    process.env.HETY_FAKE_MODE = 'database'
    const completed = done(owner, 'db-analysis')
    const beforeWrites = writes
    assert.equal((await start(request('db-analysis', { repositoryId: undefined }))).ok, true)
    assert.equal((await completed).success, true)
    const calls = databaseInspections.slice(-2)
    assert.equal(calls[0].input.sql, undefined)
    assert.match(calls[1].input.sql, /percentile_cont/)
    assert.equal(calls[1].db.password, 'DB_SECRET')
    assert.equal(calls[1].server.password, 'SSH_SECRET')
    assert.equal(calls[1].db.locked, true)
    const message = owner.events.find((e) => e.runId === 'db-analysis' && e.type === 'message').text
    assert.ok(message.includes('1001'))
    assert.ok(!message.includes('DB_SECRET'))
    assert.ok(!message.includes('SSH_SECRET'))
    assert.equal(writes, beforeWrites)
    process.env.HETY_FAKE_MODE = 'success'
  })
  await t.test('resource policies hide excluded metadata, default new resources to reads, and reject invalid modes', () => {
    const access=defaultCodexAccess(project)
    assert.equal(access.databases.db,'read')
    access.databases.db='excluded'; access.servers.server='excluded'; access.repositories.repo='excluded'
    for(const column of project.board.columns)access.planning[column.id]='excluded'
    const encoded=JSON.stringify(projectCodexContext(project,access))
    for(const hidden of ['host.example','Repository','Task details','postgres'])assert.ok(!encoded.includes(hidden))
    const prompt=buildCodexPrompt(project,request('policy',{access}),cwd)
    assert.ok(!prompt.includes('host.example'))
    assert.throws(()=>resolveCodexAccess(project,{...access,http:'invalid'}),/Invalid/)
    assert.throws(()=>resolveCodexAccess(project,{...access,databases:[]}),/Invalid/)
    assert.throws(()=>actionAccessMode(access,'database_write',{databaseId:'db'}),/excluded/)
    const newer={...project,databases:[...project.databases,{...project.databases[0],id:'new'}]}
    assert.equal(defaultCodexAccess(newer,access).databases.new,'read')
    assert.equal(resolveCodexAccess(newer,access).databases.new,'excluded')
    assert.equal(scopedCodexProject(newer,access).databases.length,0)
  })
  await t.test('excluded servers cannot be inspected but remain usable internally for an included database tunnel', async () => {
    const access=defaultCodexAccess(project);access.servers.server='excluded'
    process.env.HETY_FAKE_MODE='inspect'
    const before=inspections.length,complete=done(owner,'excluded-server')
    assert.equal((await start(request('excluded-server',{repositoryId:undefined,access}))).ok,true)
    await complete
    assert.equal(inspections.length,before)
    assert.match(owner.events.find(e=>e.runId==='excluded-server'&&e.type==='message').text,/not found in this project/)
    process.env.HETY_FAKE_MODE='database'
    const completed=done(owner,'hidden-tunnel')
    assert.equal((await start(request('hidden-tunnel',{repositoryId:undefined,access}))).ok,true)
    await completed
    assert.equal(databaseInspections.at(-1).server.password,'SSH_SECRET')
    assert.equal(projectCodexContext(project,access).databases[0].sshServerId,undefined)
    process.env.HETY_FAKE_MODE='success'
  })
  await t.test('read-only and excluded databases reject writes before preparing or executing an action', async () => {
    process.env.HETY_FAKE_MODE='write'
    for(const mode of ['read','excluded']) {
      const access=defaultCodexAccess(project);access.databases.db=mode
      const id=`access-${mode}`,before=proposedActions.length,executed=approvedActions.length,complete=done(owner,id)
      assert.equal((await start(request(id,{repositoryId:undefined,access}))).ok,true)
      await complete
      assert.equal(proposedActions.length,before);assert.equal(approvedActions.length,executed)
      assert.ok(!owner.events.some(e=>e.runId===id&&e.type==='approval'))
      assert.match(owner.events.find(e=>e.runId===id&&e.type==='message').text,mode==='read' ? /read-only/ : /excluded/)
    }
    process.env.HETY_FAKE_MODE='success'
  })
  await t.test('full access executes only the chosen database without approval and settings are snapshotted per run', async () => {
    process.env.HETY_FAKE_MODE='write'
    const access=defaultCodexAccess(project);access.databases.db='full'
    const before=approvedActions.length,complete=done(owner,'full-database')
    assert.equal((await start(request('full-database',{repositoryId:undefined,access}))).ok,true)
    access.databases.db='excluded'
    await complete
    assert.equal(approvedActions.length,before+1)
    assert.ok(!owner.events.some(e=>e.runId==='full-database'&&e.type==='approval'))
    assert.match(owner.events.find(e=>e.runId==='full-database'&&e.type==='message').text,/"approvalRequired":false/)
    const other=defaultCodexAccess(project)
    assert.throws(()=>actionAccessMode(other,'ssh_execute',{serverId:'server'}),/read-only/)
    process.env.HETY_FAKE_MODE='success'
  })
  await t.test('resource approval mode still requires review and excluded repositories cannot be selected', async () => {
    const access=defaultCodexAccess(project);access.databases.db='approval';access.repositories.repo='excluded'
    assert.equal((await start(request('excluded-repo',{access}))).ok,false)
    process.env.HETY_FAKE_MODE='write'
    const pending=writeApprovalFor(owner,'policy-approval'),complete=done(owner,'policy-approval'),before=approvedActions.length
    assert.equal((await start(request('policy-approval',{repositoryId:undefined,access}))).ok,true)
    const draft=await pending
    assert.equal(approvedActions.length,before)
    await handlers.get('codex:approveWrite')({sender:owner},{runId:'policy-approval',id:draft.id,approve:false})
    await complete;assert.equal(approvedActions.length,before)
    process.env.HETY_FAKE_MODE='read-http';access.http='excluded'
    const blocked=done(owner,'excluded-http'),requests=proposedActions.length
    assert.equal((await start(request('excluded-http',{repositoryId:undefined,access}))).ok,true)
    await blocked;assert.equal(proposedActions.length,requests)
    assert.match(owner.events.find(e=>e.runId==='excluded-http'&&e.type==='message').text,/excluded/)
    process.env.HETY_FAKE_MODE='success'
  })
  await t.test('included repositories can be read and written by ID without selecting a working folder', async () => {
    const access=defaultCodexAccess(project)
    process.env.HETY_FAKE_MODE='local-read'
    const complete=done(owner,'repo-read')
    assert.equal((await start(request('repo-read',{repositoryId:undefined,access}))).ok,true)
    await complete;assert.equal(localInspections.at(-1).cwd,project.repositories[0].path)
    access.repositories.repo='excluded'
    const before=localInspections.length,denied=done(owner,'repo-excluded')
    assert.equal((await start(request('repo-excluded',{repositoryId:undefined,access}))).ok,true)
    await denied;assert.equal(localInspections.length,before)
    process.env.HETY_FAKE_MODE='local-write';access.repositories.repo='full'
    const written=done(owner,'repo-full'),executed=approvedActions.length
    assert.equal((await start(request('repo-full',{repositoryId:undefined,access}))).ok,true)
    await written;assert.equal(approvedActions.length,executed+1)
    assert.equal(proposedActions.at(-1).context.cwd,project.repositories[0].path)
    process.env.HETY_FAKE_MODE='success'
  })
  await t.test('each write waits for its own exact-action approval and rejects another window or replay', async () => {
    process.env.HETY_FAKE_MODE='write'
    for(const id of ['write-1','write-2']) {
      const before=approvedActions.length
      const pending=writeApprovalFor(owner,id),completed=done(owner,id)
      assert.equal((await start(request(id,{repositoryId:undefined}))).ok,true)
      const draft=await pending
      assert.match(draft.details,/UPDATE scores/)
      assert.equal(approvedActions.length,before)
      const input={runId:id,id:draft.id,approve:true}
      assert.equal((await handlers.get('codex:approveWrite')({sender:new Owner(2)},input)).ok,false)
      assert.equal((await handlers.get('codex:approveWrite')({sender:owner},{...input,id:'wrong'})).ok,false)
      assert.equal((await handlers.get('codex:approveWrite')({sender:owner},input)).ok,true)
      assert.equal((await completed).success,true)
      assert.equal(approvedActions.length,before+1)
      assert.equal((await handlers.get('codex:approveWrite')({sender:owner},input)).ok,false)
      assert.match(owner.events.find((e) => e.runId===id && e.type==='message').text,/"approved":true/)
    }
    process.env.HETY_FAKE_MODE='success'
  })
  await t.test('declined or stopped writes never execute', async () => {
    process.env.HETY_FAKE_MODE='write'
    for(const id of ['declined-write','stopped-write']) {
      const before=approvedActions.length,pending=writeApprovalFor(owner,id),completed=done(owner,id)
      assert.equal((await start(request(id))).ok,true)
      const draft=await pending
      if(id==='declined-write')assert.equal((await handlers.get('codex:approveWrite')({sender:owner},{runId:id,id:draft.id,approve:false})).ok,true)
      else assert.equal(handlers.get('codex:cancel')({sender:owner},id).ok,true)
      await completed;assert.equal(approvedActions.length,before)
    }
    process.env.HETY_FAKE_MODE='success'
  })
  await t.test('disabled write settings block proposals, GET runs without approval, and write failures are reported', async () => {
    process.env.HETY_FAKE_MODE='write'
    const completed=done(owner,'disabled-write'),before=approvedActions.length
    assert.equal((await start(request('disabled-write',{permissions:{databaseWrites:false,serverWrites:true,uploads:true,apiWrites:true,localWrites:false}}))).ok,true)
    await completed;assert.equal(approvedActions.length,before)
    assert.ok(!owner.events.some((e) => e.runId==='disabled-write'&&e.writeApproval))
    process.env.HETY_FAKE_MODE='read-http'
    const read=done(owner,'read-http');assert.equal((await start(request('read-http'))).ok,true);await read
    assert.ok(!owner.events.some((e) => e.runId==='read-http'&&e.writeApproval))
    assert.equal(approvedActions.at(-1).kind,'http_request')
    process.env.HETY_FAKE_MODE='write';process.env.HETY_WRITE_REASON='fail'
    const pending=writeApprovalFor(owner,'failed-write'),failed=done(owner,'failed-write')
    assert.equal((await start(request('failed-write'))).ok,true)
    const draft=await pending
    assert.equal((await handlers.get('codex:approveWrite')({sender:owner},{runId:'failed-write',id:draft.id,approve:true})).ok,false)
    await failed
    assert.match(owner.events.find((e) => e.runId==='failed-write'&&e.type==='message').text,/Synthetic write failure/)
    delete process.env.HETY_WRITE_REASON;process.env.HETY_FAKE_MODE='success'
  })
  await t.test('adding a discovered database waits for approval, saves reviewed fields and rejects replay or another window', async () => {
    process.env.HETY_FAKE_MODE = 'propose'
    const approval = approvalFor(owner, 'approve')
    const completed = done(owner, 'approve')
    const count = data.projects[0].databases.length
    const beforeWrites = writes
    assert.equal((await start(request('approve', { repositoryId: undefined }))).ok, true)
    const draft = await approval
    assert.equal(data.projects[0].databases.length, count)
    assert.equal(writes, beforeWrites)
    const input = { runId: 'approve', id: draft.id, approve: true, database: { ...draft.database, name: 'Reviewed production database' } }
    assert.equal((await handlers.get('codex:approveDatabase')({ sender: new Owner(2) }, input)).ok, false)
    const result = await handlers.get('codex:approveDatabase')({ sender: owner }, input)
    assert.equal(result.ok, true)
    assert.equal((await completed).success, true)
    assert.equal(data.projects[0].databases.length, count + 1)
    const saved = data.projects[0].databases.at(-1)
    assert.equal(saved.name, 'Reviewed production database')
    assert.equal(saved.password, 'DISCOVERED_PASSWORD')
    assert.equal(saved.useSsh, true)
    assert.equal(saved.sshServerId, 'server')
    assert.equal(saved.locked, true)
    assert.equal((await handlers.get('codex:approveDatabase')({ sender: owner }, input)).ok, false)
    assert.equal(data.projects[1].databases.length, count)
    process.env.HETY_FAKE_MODE = 'success'
  })
  await t.test('declining the proposal leaves the project unchanged', async () => {
    process.env.HETY_FAKE_MODE = 'propose'
    const approval = approvalFor(owner, 'decline')
    const completed = done(owner, 'decline')
    const count = data.projects[0].databases.length
    assert.equal((await start(request('decline'))).ok, true)
    const draft = await approval
    assert.equal((await handlers.get('codex:approveDatabase')({ sender: owner }, { runId: 'decline', id: draft.id, approve: false })).ok, true)
    assert.equal((await completed).success, true)
    assert.equal(data.projects[0].databases.length, count)
    assert.match(owner.events.find((e) => e.runId === 'decline' && e.type === 'message').text, /User declined/)
    process.env.HETY_FAKE_MODE = 'success'
  })
  await t.test('a failed vault write leaves the proposal pending and supports retry', async () => {
    process.env.HETY_FAKE_MODE = 'propose'
    const approval = approvalFor(owner, 'retry-save')
    const completed = done(owner, 'retry-save')
    const count = data.projects[0].databases.length
    assert.equal((await start(request('retry-save'))).ok, true)
    const draft = await approval
    const input = { runId: 'retry-save', id: draft.id, approve: true }
    failFlush = true
    assert.equal((await handlers.get('codex:approveDatabase')({ sender: owner }, input)).ok, false)
    assert.equal(data.projects[0].databases.length, count)
    assert.equal((await handlers.get('codex:approveDatabase')({ sender: owner }, input)).ok, true)
    assert.equal((await completed).success, true)
    assert.equal(data.projects[0].databases.length, count + 1)
    process.env.HETY_FAKE_MODE = 'success'
  })
  await t.test('stopping while approval is pending never saves the connection', async () => {
    process.env.HETY_FAKE_MODE = 'propose'
    const approval = approvalFor(owner, 'cancel-approval')
    const completed = done(owner, 'cancel-approval')
    const count = data.projects[0].databases.length
    assert.equal((await start(request('cancel-approval'))).ok, true)
    await approval
    assert.equal(handlers.get('codex:cancel')({ sender: owner }, 'cancel-approval').ok, true)
    assert.equal((await completed).cancelled, true)
    assert.equal(data.projects[0].databases.length, count)
    process.env.HETY_FAKE_MODE = 'success'
  })
  await t.test('rejects unknown projects, unknown repositories, missing folders, and oversized prompts', async () => {
    for (const extra of [{ projectId: 'missing' }, { repositoryId: 'missing' }, { repositoryId: undefined, folder: path.join(temporary, 'missing') }, { prompt: 'x'.repeat(32001) }, { history: [null] }]) {
      assert.equal((await start(request('invalid', extra))).ok, false)
    }
  })
  await t.test('reports CLI exit failures and releases the project for another prompt', async () => {
    process.env.HETY_FAKE_MODE = 'fail'
    const completed = done(owner, 'failure')
    assert.equal((await start(request('failure'))).ok, true)
    assert.equal((await completed).success, false)
    assert.match(owner.events.find((e) => e.runId === 'failure' && e.type === 'error').text, /Synthetic authentication failure/)
    process.env.HETY_FAKE_MODE = 'success'
  })
  await t.test('prevents concurrent runs and rejects cancellation from another window', async () => {
    process.env.HETY_FAKE_MODE = 'hang'
    const completed = done(owner, 'cancel')
    assert.equal((await start(request('cancel'))).ok, true)
    assert.equal((await start(request('duplicate'))).ok, false)
    assert.equal(handlers.get('codex:cancel')({ sender: new Owner(2) }, 'cancel').ok, false)
    assert.equal(handlers.get('codex:cancel')({ sender: owner }, 'cancel').ok, true)
    const result = await completed
    assert.equal(result.cancelled, true)
    assert.equal(result.success, false)
    process.env.HETY_FAKE_MODE = 'success'
  })
  await t.test('explains setup when the CLI is missing', async () => {
    process.env.PATH = ''
    process.env.APPDATA = path.join(temporary, 'empty')
    const status = await checkCodex(true)
    assert.equal(status.installed, false)
    assert.equal(status.authenticated, false)
    assert.match(status.message, /npm install -g @openai\/codex/)
  })
  if (process.platform === 'win32') await t.test('bypasses the npm wrapper to launch the native binary without a console', async () => {
    process.env.PATH = npm
    const target = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    const executable = path.join(path.dirname(entry), '..', 'vendor', target + '-pc-windows-msvc', 'bin', 'codex.exe')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, '')
    const launcher = await findCodex()
    assert.equal(fs.realpathSync.native(launcher.command), fs.realpathSync.native(executable))
    assert.deepEqual(launcher.prefix, [])
  })
  await t.test('the loopback tool bridge blocks unknown tokens, browser origins and servers outside the project', async () => {
    const controller = new AbortController()
    let inspected = false
    let queried = false
    const bridge = await startHetyBridge({ getProject: () => project, signal: controller.signal, activity: () => {}, database: async () => { queried = true; return {} }, inspect: async () => { inspected = true; return {code:0,stdout:'ok',stderr:'',truncated:false} }, propose: async () => ({ added:false }) })
    try {
      const rpc = (method, params = {}, headers = {}, url = bridge.url) => fetch(url, { method:'POST', headers:{'Content-Type':'application/json',...headers}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}) })
      assert.equal((await rpc('tools/list', {}, {}, bridge.url.replace(/mcp\/.+/, 'mcp/wrong'))).status, 403)
      assert.equal((await rpc('tools/list', {}, {Origin:'https://untrusted.example'})).status, 403)
      const context = JSON.stringify((await (await rpc('tools/call', {name:'get_project',arguments:{}})).json()).result)
      assert.ok(!context.includes('SSH_SECRET'))
      const unknown = await (await rpc('tools/call', {name:'ssh_inspect',arguments:{serverId:'other-project-server',operation:'overview'}})).json()
      assert.equal(unknown.result.isError, true)
      assert.equal(inspected, false)
      const tools = (await (await rpc('tools/list')).json()).result.tools.map((tool) => tool.name)
      assert.ok(tools.includes('database_schema') && tools.includes('database_query'))
      for (const name of ['database_schema','database_query']) {
        const result = (await (await rpc('tools/call', {name, arguments:{databaseId:'another-project-db',sql:'SELECT 1'}})).json()).result
        assert.equal(result.isError, true)
      }
      assert.equal(queried, false)
      const missingSql = (await (await rpc('tools/call', {name:'database_query',arguments:{databaseId:'db'}})).json()).result
      assert.equal(missingSql.isError, true)
      const invalid = await (await rpc('tools/call', {name:'propose_database',arguments:{name:'x',kind:'postgresql',host:'localhost',port:5432,database:'x',username:'x',password:'x',useSsh:true,sshServerId:'other-project-server',source:'/app/.env'}})).json()
      assert.equal(invalid.result.isError, true)
    } finally { controller.abort(); bridge.close() }
  })
})
