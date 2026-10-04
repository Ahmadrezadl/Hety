const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
let open, pgClient, mysqlConnection, clickhouseClient, clickhouseOptions, driverFactory, sshClient
const originalLoad = Module._load
Module._load = function (name, parent, ...rest) {
  if (name === 'electron') return {ipcMain:{handle(){}},BrowserWindow:{getAllWindows:() => []}}
  if (parent.filename.endsWith(path.join('ipc','db.ts')) && name === './ssh') return {connectConfig:(server) => ({host:server.host,password:server.password})}
  if (parent.filename.endsWith(path.join('ipc','db.ts')) && name === './drivers') return {createDriver:(...args) => driverFactory(...args)}
  if (name === 'ssh2') return {Client:class extends EventEmitter {
    constructor(){super();sshClient=this;this.destroyed=false}
    connect(config){this.config=config;setImmediate(() => {if(!this.destroyed)this.emit('ready')})}
    destroy(){this.destroyed=true}
  }}
  if (name === '../ipc/db' && parent.filename.endsWith('codexDb.ts')) return {
    openConnection: (...args) => open(...args),
    cellToValue: (v) => v == null ? null : v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? '0x' + v.toString('hex') : typeof v === 'object' ? JSON.stringify(v) : v
  }
  if (name === 'pg') return { Client: class { constructor(options) { pgClient.options = options; return pgClient } }, types: { setTypeParser() {} } }
  if (name === 'mysql2/promise') return { createConnection: async () => mysqlConnection }
  if (name === '@clickhouse/client') return { createClient: (options) => { clickhouseOptions = options; return clickhouseClient } }
  if (name.startsWith('@shared/')) name = path.join(root, 'src/shared', name.slice(8) + '.ts')
  return originalLoad.call(this, name, parent, ...rest)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText, filename)
const { analysisSql } = require('../src/main/lib/codexSql.ts')
const { inspectDatabase } = require('../src/main/lib/codexDb.ts')
const { createPostgres } = require('../src/main/ipc/drivers/postgres.ts')
const { createMysql } = require('../src/main/ipc/drivers/mysql.ts')
const { createClickHouse } = require('../src/main/ipc/drivers/clickhouse.ts')
const { openConnection } = require('../src/main/ipc/db.ts')
const db = { id:'prod', name:'Production', kind:'postgresql', host:'localhost', port:5432, database:'production', username:'app', password:'DB_SECRET', locked:true, useSsh:true, sshServerId:'server' }
const server = { id:'server', password:'SSH_SECRET', keyPassphrase:'KEY_SECRET' }
const params = { host:'localhost', port:5432, database:'production', username:'app', password:'DB_SECRET', readOnly:true }
const signal = () => new AbortController().signal

test('analysis accepts exact aggregates and CTE/window median queries, limiting only their final results', () => {
  const queries = [
    'SELECT COUNT(*), MIN(score), MAX(score), AVG(score), percentile_cont(0.5) WITHIN GROUP (ORDER BY score) FROM public.scores WHERE submitted_at IS NOT NULL AND score IS NOT NULL;',
    'WITH ranked AS (SELECT score, ROW_NUMBER() OVER (ORDER BY score) AS rn, COUNT(*) OVER () AS n FROM scores WHERE score IS NOT NULL) SELECT AVG(score) FROM ranked WHERE rn IN (FLOOR((n+1)/2), FLOOR((n+2)/2))',
    `SELECT "delete", 'UPDATE; it''s safe' AS label FROM "score-data" -- comment`,
    'SELECT pg_catalog.avg(score), CAST(score AS NUMERIC(10,2)) FROM public.scores GROUP BY score',
    'SELECT min(score), max(score), avg(score), quantileExact(0.5)(score) FROM scores'
  ]
  for (const query of queries) {
    const wrapped = analysisSql(query)
    assert.ok(wrapped.startsWith('SELECT * FROM (\n'))
    assert.ok(wrapped.endsWith('\n) AS hety_analysis_result LIMIT 201'))
    assert.equal((wrapped.match(/LIMIT 201/g) || []).length, 1)
  }
})

test('analysis rejects writes, write CTEs, files, settings, custom functions and lexical bypasses', () => {
  for (const query of [
    'DELETE FROM scores', 'WITH changed AS (DELETE FROM scores RETURNING *) SELECT * FROM changed',
    'SELECT 1; DROP TABLE scores', 'SELECT * INTO other FROM scores', "SELECT * FROM scores INTO OUTFILE '/tmp/data'",
    'SELECT * FROM scores FOR UPDATE', 'SELECT * FROM scores FOR SHARE', 'SELECT 1 SETTINGS readonly=0',
    "SELECT lo_export(1, '/tmp/file')", "SELECT dblink_exec('conn','DELETE FROM scores')", "SELECT set_config('transaction_read_only','off',false)",
    'SELECT public.avg(score) FROM scores', 'SELECT "evil"()', 'SELECT "CoUnT"(score) FROM scores', 'SELECT pg_catalog."lo_export"(1)', 'SELECT other.pg_catalog.avg(score) FROM scores', 'SELECT over()', 'SELECT filter()',
    'SELECT SLEEP(30)', "SELECT LOAD_FILE('/etc/passwd')", 'SELECT * FROM url(\'http://example.com\')',
    'SELECT /*!50000 1 INTO OUTFILE \'/tmp/file\' */ 1', 'SELECT /* hint */ 1', 'SELECT $$unsafe$$',
    'SELECT @variable := 1', "SELECT 'back\\slash'", "SELECT 'unterminated", 'SELECT 1\0', null, 'SELECT ' + '1'.repeat(32000)
  ]) assert.throws(() => analysisSql(query), undefined, String(query))
})

test('isolated saved connection preserves SSH credentials internally, calculates aggregates, and normalizes cells', async () => {
  let received, executed, closed = 0, tunnelsClosed = 0
  open = async (...args) => {
    received = args
    return { driver:{ queryReadOnly:async (sql) => { executed = sql; return { columns:['count','min','max','average','median','date','binary'], rows:[[1001,1,9999,14.98,5,new Date('2026-01-01'),Buffer.from('a')]] } }, close:async () => closed++ }, tunnel:{close:() => tunnelsClosed++} }
  }
  const result = await inspectDatabase(db, server, {sql:'SELECT COUNT(*), MIN(score), MAX(score), AVG(score), percentile_cont(0.5) WITHIN GROUP (ORDER BY score) FROM public.scores'}, signal())
  assert.equal(received[0], db)
  assert.equal(received[1], server)
  assert.equal(received[3].readOnly, true)
  assert.equal(db.locked, true)
  assert.match(executed, /FROM public.scores\n\) AS hety_analysis_result LIMIT 201$/)
  assert.equal(result.rows[0][0], 1001)
  assert.equal(result.rows[0][5], '2026-01-01T00:00:00.000Z')
  assert.equal(result.rows[0][6], '0x61')
  assert.equal(result.truncated, false)
  assert.equal(result.returnedRowCount, 1)
  assert.ok(!JSON.stringify(result).includes('SECRET'))
  assert.equal(closed, 1)
  assert.equal(tunnelsClosed, 1)
})

test('row and byte caps report truncation without presenting capped row counts as total counts', async () => {
  open = async () => ({ driver:{ queryReadOnly:async () => ({columns:['score'],rows:Array.from({length:201},(_,i) => [i])}), close:async () => {} } })
  const result = await inspectDatabase(db, server, {sql:'SELECT score FROM public.scores'}, signal())
  assert.equal(result.rows.length, 200)
  assert.equal(result.truncated, true)
  assert.equal(result.totalRowCount, undefined)
  open = async () => ({ driver:{ queryReadOnly:async () => ({columns:['value'],rows:[['small'],['x'.repeat(130000)]]}), close:async () => {} } })
  const bounded = await inspectDatabase(db, server, {sql:'SELECT value FROM public.scores'}, signal())
  assert.equal(bounded.rows.length, 1)
  assert.equal(bounded.truncated, true)
})

test('schema inspection narrows large schemas and provides primary/foreign-key metadata without rows', async () => {
  const tables = Array.from({length:150},(_,i) => ({name:'table'+i,columns:[{name:'score',type:'numeric',pk:false,ref:{schema:'public',table:'users',column:'id'}}]}))
  open = async () => ({ driver:{ introspect:async () => ({schemas:[{name:'public',tables,views:[],enums:[]}]}), close:async () => {} } })
  const all = await inspectDatabase(db, server, {}, signal())
  assert.equal(all.returnedRelations, 100)
  assert.equal(all.totalRelations, 150)
  assert.equal(all.truncated, true)
  const exact = await inspectDatabase(db, server, {schema:'public',table:'table149'}, signal())
  assert.equal(exact.returnedRelations, 1)
  assert.equal(exact.truncated, false)
  assert.equal(exact.schemas[0].tables[0].columns[0].ref.table, 'users')
  assert.equal(exact.rows, undefined)
})

test('invalid SQL, unsupported engines and already cancelled runs never open a database', async () => {
  open = async () => { throw new Error('Should not connect') }
  await assert.rejects(inspectDatabase(db, server, {sql:'DELETE FROM scores'}, signal()), /SELECT/)
  await assert.rejects(inspectDatabase({...db,kind:'sqlserver'}, server, {sql:'SELECT 1'}, signal()), /schema inspection only/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(inspectDatabase(db, server, {sql:'SELECT 1'}, controller.signal), /stopped/)
})

test('Stop immediately aborts an active isolated driver and closes its SSH tunnel', async () => {
  const controller = new AbortController()
  let aborts = 0, closes = 0, started
  const queried = new Promise((resolve) => started = resolve)
  open = async () => ({ driver:{queryReadOnly:async () => {started(); return new Promise(() => {})},abort:() => aborts++,close:async () => {}},tunnel:{close:() => closes++} })
  const result = inspectDatabase(db, server, {sql:'SELECT 1'}, controller.signal)
  await queried; controller.abort()
  await assert.rejects(result, /stopped/)
  assert.equal(aborts, 1)
  assert.ok(closes >= 1)
})

test('deadline aborts work; errors redact database and server secrets', async () => {
  const realSetTimeout = global.setTimeout
  let aborted = false
  open = async () => ({driver:{queryReadOnly:async () => new Promise(() => {}),abort:() => aborted = true,close:async () => {}}})
  global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 45000 ? 15 : ms, ...args)
  try { await assert.rejects(inspectDatabase(db, server, {sql:'SELECT 1'}, signal()), /timed out/); assert.equal(aborted,true) }
  finally { global.setTimeout = realSetTimeout }
  open = async () => {throw new Error('connection DB_SECRET SSH_SECRET KEY_SECRET failed')}
  await assert.rejects(inspectDatabase(db, server, {}, signal()), (error) => !error.message.includes('SECRET') && error.message.includes('[redacted]'))
})

test('PostgreSQL driver uses READ ONLY, timeout, protected function search path and rollback even on failure', async () => {
  const commands = []
  let fail = false
  pgClient = new EventEmitter()
  pgClient.connect = async () => {}
  pgClient.end = async () => {}
  pgClient.query = async (arg) => { commands.push(arg); if (typeof arg === 'object' && fail) throw new Error('Query failed'); return {fields:[{name:'count'}],rows:[[1001]],rowCount:1,command:'SELECT'} }
  const driver = await createPostgres(params)
  assert.equal(pgClient.options.statement_timeout, 30000)
  assert.equal((await driver.queryReadOnly('SELECT COUNT(*) FROM scores')).rows[0][0], 1001)
  assert.equal(commands[0], 'BEGIN READ ONLY')
  assert.equal(commands[1], 'SET LOCAL search_path = pg_catalog, public')
  assert.equal(commands.at(-1), 'ROLLBACK')
  fail = true
  await assert.rejects(driver.queryReadOnly('SELECT COUNT(*) FROM scores'), /Query failed/)
  assert.equal(commands.at(-1), 'ROLLBACK')
})

test('MySQL/MariaDB driver starts a READ ONLY transaction, rolls back and can destroy active connections', async () => {
  const commands = []
  let fail = false, rollbacks = 0, destroyed = 0
  mysqlConnection = new EventEmitter()
  mysqlConnection.query = async (arg) => { commands.push(arg); if (typeof arg === 'object' && fail) throw new Error('Query failed'); return [[[1001]],[{name:'count'}]] }
  mysqlConnection.rollback = async () => rollbacks++
  mysqlConnection.destroy = () => destroyed++
  const driver = await createMysql(params,'MySQL')
  assert.equal((await driver.queryReadOnly('SELECT COUNT(*) FROM scores')).rows[0][0], 1001)
  assert.equal(commands[0], 'START TRANSACTION READ ONLY')
  assert.equal(commands[1].timeout, 30000)
  assert.equal(rollbacks, 1)
  fail = true
  await assert.rejects(driver.queryReadOnly('SELECT 1'), /Query failed/)
  assert.equal(rollbacks, 2)
  driver.abort(); assert.equal(destroyed, 1)
})

test('PostgreSQL approved batches preserve statement outcomes and RETURNING data',async()=>{
  pgClient=new EventEmitter();pgClient.connect=async()=>{};pgClient.end=async()=>{}
  pgClient.query=async()=>[
    {command:'BEGIN',rowCount:null,fields:[],rows:[]},
    {command:'UPDATE',rowCount:2,fields:[{name:'id'}],rows:[[7],[8]]},
    {command:'SELECT',rowCount:1,fields:[{name:'verified'}],rows:[[true]]},
    {command:'COMMIT',rowCount:null,fields:[],rows:[]}
  ]
  const driver=await createPostgres({...params,readOnly:false,timeoutMs:30000})
  const result=await driver.query('BEGIN; UPDATE games SET active=true RETURNING id; SELECT true AS verified; COMMIT;')
  assert.equal(pgClient.options.statement_timeout,30000)
  assert.deepEqual(result.columns,['verified'])
  assert.deepEqual(result.rows,[[true]])
  assert.deepEqual(result.statements,[{command:'BEGIN',rowCount:0},{command:'UPDATE',rowCount:2},{command:'SELECT',rowCount:1},{command:'COMMIT',rowCount:0}])
})

test('ClickHouse query and connection enforce readonly settings and a server execution deadline', async () => {
  const commands = []
  clickhouseClient = {query:async (arg) => {commands.push(arg);return {json:async () => ({meta:[{name:'count'}],data:[[1001]],rows:1})}},close:async () => {}}
  const driver = await createClickHouse(params)
  const result = await driver.queryReadOnly('SELECT COUNT(*) FROM scores')
  assert.equal(clickhouseOptions.clickhouse_settings.readonly, '1')
  assert.equal(clickhouseOptions.request_timeout, 30000)
  assert.equal(commands.at(-1).clickhouse_settings.readonly, '1')
  assert.equal(commands.at(-1).clickhouse_settings.max_execution_time, 30)
  assert.equal(result.rows[0][0], 1001)
  const querySignal = commands.at(-1).abort_signal
  driver.abort()
  assert.equal(querySignal.aborted, true)
})

test('the real connection helper creates an isolated loopback tunnel and closes it on cancellation', async () => {
  let received
  driverFactory = async (_kind, params) => {received=params;return {close:async () => {}}}
  const controller = new AbortController()
  const connection = await openConnection(db, {...server,host:'server.example'}, undefined, {signal:controller.signal,readOnly:true})
  assert.equal(received.host,'127.0.0.1')
  assert.ok(received.port > 0)
  assert.equal(received.password,'DB_SECRET')
  assert.equal(received.readOnly,true)
  let keyboardAnswer
  sshClient.emit('keyboard-interactive','','','',[{prompt:'Password:'}], (answer) => keyboardAnswer=answer)
  assert.deepEqual(keyboardAnswer,['SSH_SECRET'])
  controller.abort()
  assert.equal(sshClient.destroyed,true)
  connection.tunnel.close() // Repeated close is safe.
  await connection.driver.close()
})

test('connection cancellation while SSH is connecting and after a late driver connection releases resources', async () => {
  const pending = new AbortController()
  driverFactory = async () => {throw new Error('Should not create a driver')}
  const connecting = openConnection(db,server,undefined,{signal:pending.signal,readOnly:true})
  pending.abort()
  await assert.rejects(connecting,/stopped/)
  assert.equal(sshClient.destroyed,true)
  const controller = new AbortController()
  let created, complete, aborted = false, closed = false
  const factoryStarted = new Promise((resolve) => created=resolve)
  driverFactory = async () => {created();return new Promise((resolve) => complete=resolve)}
  const late = openConnection(db,server,undefined,{signal:controller.signal,readOnly:true})
  await factoryStarted; controller.abort()
  complete({abort:() => aborted=true,close:async () => closed=true})
  await assert.rejects(late,/stopped/)
  assert.equal(aborted,true)
  assert.equal(closed,true)
  assert.equal(sshClient.destroyed,true)
})
