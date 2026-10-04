// Opt-in real CLI smoke test. Only synthetic resources; never opens Hety's vault.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const originalLoad = Module._load
Module._load = function (name, parent, ...rest) {
  if (name.startsWith('@shared/')) name = path.join(root, 'src/shared', name.slice(8) + '.ts')
  return originalLoad.call(this, name, parent, ...rest)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename)
const { startHetyBridge } = require('../src/main/lib/hetyMcp.ts')
const { findCodex, codexIsolationArgs, spawnCodex, stopCodex } = require('../src/main/lib/codex.ts')
const { buildCodexPrompt } = require('../src/shared/codex.ts')
const { analysisSql } = require('../src/main/lib/codexSql.ts')
async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hety-real-codex-'))
  const controller = new AbortController()
  const project = { id: 'synthetic', name: 'Synthetic smoke test', description: '', group: '', tags: [], repositories: [], servers: [], databases: [{ id: 'synthetic-db', name: 'Production (synthetic)', kind: 'postgresql', host: 'example.invalid', port: 5432, database: 'synthetic', username: 'synthetic', password: '', useSsh: false }], createdAt: 0, lastOpenedAt: 0 }
  let queries = 0, schemas = 0, toolsListed = false, child, bridge, timer
  try {
    const launcher = await findCodex()
    if (!launcher) throw new Error('Codex is not installed.')
    const isolation = await codexIsolationArgs(launcher, cwd)
    bridge = await startHetyBridge({ signal: controller.signal, getProject: () => project, activity: console.log,
      onToolsListed: names => { toolsListed = names.includes('database_query') && names.includes('database_schema') },
      inspect: async () => { throw new Error('No SSH in this test.') }, propose: async () => { throw new Error('No writes in this test.') },
      database: async (id, input) => {
        if (id !== 'synthetic-db') throw new Error('Unexpected database.')
        if (input.sql) {
          analysisSql(input.sql)
          queries++
          return /GROUP\s+BY/i.test(input.sql) ? { readOnly: true, columns: ['is_submitted','row_count','non_null_score_count','null_score_count'],rows:[[true,4,4,0]],truncated:false } : { readOnly: true, columns: ['count', 'min', 'max', 'median', 'average'], rows: [[4, 2, 8, 5, 5]], truncated: false }
        }
        schemas++; return { schemas: [{name:'public', tables:[{name:'scores',columns:[{name:'score',type:'numeric'},{name:'submitted_at',type:'timestamp'}]}]}] }
      }
    })
    child = spawnCodex(launcher, [...isolation, '-c', `mcp_servers.hety={url=${JSON.stringify(bridge.url)},enabled=true,required=true,tool_timeout_sec=600,default_tools_approval_mode="approve"}`, '--ask-for-approval', 'never', 'exec', '--json', '--color', 'never', '--sandbox', 'read-only', '--skip-git-repo-check', '-'], cwd)
    let output = '', stderr = ''
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1000000) stopCodex(child) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000) })
    timer = setTimeout(() => stopCodex(child), 180000)
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    child.stdin.end(buildCodexPrompt(project, { prompt: 'This is a synthetic integration test. Use Hety database_schema and database_query to calculate count, min, max, median and average of submitted non-null scores. Report the returned synthetic results. Do not access any other systems.', history: [{role:'assistant',text:'An earlier Hety session exposed no SQL query tool, so I could not retrieve statistics.'}], allowEdits: false }, cwd))
    const code = await done
    clearTimeout(timer)
    for (const line of output.split('\n')) {
      try { const event = JSON.parse(line); if (['agent_message', 'mcp_tool_call'].includes(event.item?.type) || ['error','turn.failed'].includes(event.type)) console.log(JSON.stringify(event)) } catch {}
    }
    console.log(JSON.stringify({ code, toolsListed, schemas, queries, stderr }))
    if (code !== 0 || !toolsListed || !schemas || !queries) throw new Error('Real Codex did not use both database tools.')
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) stopCodex(child)
    controller.abort(); bridge?.close()
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
