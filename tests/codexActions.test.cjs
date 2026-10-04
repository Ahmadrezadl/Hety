const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const {EventEmitter} = require('node:events')
const {Writable} = require('node:stream')
const Module = require('node:module')
const ts = require('typescript')
const root = path.resolve(__dirname,'..')
let connectionFactory, commands=[], transfers=[], ssh
const originalLoad=Module._load
Module._load=function(name,parent,...rest){
  if(name==='../ipc/db'&&parent.filename.endsWith('codexActions.ts'))return {openConnection:(...args)=>connectionFactory(...args),cellToValue:(value)=>value??null}
  if(name==='../ipc/ssh'&&parent.filename.endsWith('codexActions.ts'))return {connectConfig:(server)=>({host:server.host,password:server.password})}
  if(name==='./codexSsh'&&parent.filename.endsWith('codexActions.ts'))return {executeServerCommand:async (...args)=>{commands.push(args);return {code:0,stdout:'done',stderr:'',truncated:false}}}
  if(name==='ssh2')return {Client:class extends EventEmitter {
    constructor(){super();ssh=this}
    connect(config){this.config=config;setImmediate(()=>this.emit('ready'))}
    destroy(){this.destroyed=true}
    sftp(callback){callback(null,{createWriteStream:(remotePath)=>new Writable({write(chunk,_encoding,next){transfers.push({remotePath,chunk});next()},final(next){next()}})})}
  }}
  if(name.startsWith('@shared/'))name=path.join(root,'src/shared',name.slice(8)+'.ts')
  return originalLoad.call(this,name,parent,...rest)
}
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(require('node:fs').readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,filename)
const {prepareAction,attachmentAt,inspectLocal}=require('../src/main/lib/codexActions.ts')
const project={id:'project',databases:[{id:'db',name:'Production',kind:'postgresql',host:'db.example',port:5432,database:'app',password:'DATABASE_SECRET',locked:true,useSsh:true,sshServerId:'server'}],servers:[{id:'server',name:'Production server',host:'server.example',port:22,username:'deploy',password:'SSH_SECRET'}]}
const permissions={databaseWrites:true,serverWrites:true,uploads:true,apiWrites:true,localWrites:true}
const context=(extra={})=>({getProject:()=>project,permissions:{...permissions},attachments:[],...extra})
const signal=()=>new AbortController().signal

test('database preparation does not execute SQL; execution uses a separate saved connection and leaves the lock intact',async()=>{
  let connected=0,closed=0,submitted=[]
  connectionFactory=async(db,server)=>{connected++;assert.equal(db.password,'DATABASE_SECRET');assert.equal(server.password,'SSH_SECRET');return {driver:{query:async(sql)=>{submitted.push(sql);return {columns:[],rows:[],rowCount:7,command:'UPDATE'}},close:async()=>closed++}}}
  const sql="UPDATE public.games SET banner='https://assets.example/banner.png' WHERE id=7"
  const prepared=await prepareAction('database_write',{databaseId:'db',sql,reason:'Update banner'},context())
  assert.equal(connected,0)
  assert.equal(prepared.review.details,sql)
  assert.match(prepared.review.target,/Production.*db.example.*via Production server/)
  assert.ok(!JSON.stringify(prepared.review).includes('SECRET'))
  const result=await prepared.execute(signal())
  assert.equal(result.affectedRows,7)
  assert.deepEqual(submitted,[sql])
  assert.equal(project.databases[0].locked,true)
  assert.equal(closed,1)
})

test('write preparation enforces project membership and each permission before execution',async()=>{
  for(const [kind,input,key] of [
    ['database_write',{databaseId:'db',sql:'UPDATE games SET banner=null'},'databaseWrites'],
    ['ssh_execute',{serverId:'server',command:'systemctl restart app'},'serverWrites'],
    ['ssh_upload',{serverId:'server',fileId:'file',remotePath:'/srv/a.png'},'uploads'],
    ['http_request',{url:'https://example.test/api',method:'PUT',body:'{}'},'apiWrites'],
    ['local_write',{path:'a.txt',content:'new'},'localWrites'],
    ['local_execute',{executable:'git',args:['commit','-am','change']},'localWrites']
  ])await assert.rejects(prepareAction(kind,{...input,reason:'Write'},context({permissions:{...permissions,[key]:false}})),/disabled/)
  for(const [kind,input] of [['database_write',{databaseId:'outside',sql:'DELETE FROM t'}],['ssh_execute',{serverId:'outside',command:'ls'}]])await assert.rejects(prepareAction(kind,{...input,reason:'Write'},context()),/not found in this project/)
  await assert.rejects(prepareAction('ssh_execute',{serverId:'server',command:'ls',sudo:'yes',reason:'Write'},context()),/sudo/)
})

test('open or rolled-back PostgreSQL batches are not reported as committed changes',async()=>{
  for(const ending of ['BEGIN','ROLLBACK']){
    connectionFactory=async()=>({driver:{query:async()=>({columns:[],rows:[],rowCount:2,statements:[{command:'UPDATE',rowCount:2},{command:ending,rowCount:0}]}),close:async()=>{}}})
    const prepared=await prepareAction('database_write',{databaseId:'db',sql:'BEGIN; UPDATE games SET active=true;',reason:'Transaction check'},context())
    const result=await prepared.execute(signal())
    assert.equal(result.affectedRows,null)
    assert.match(result.transactionOutcome,/rolled back|ROLLBACK/)
    if(ending==='BEGIN')assert.equal(result.success,false)
  }
})

test('saved targets cannot change between proposal and approved execution',async()=>{
  const prepared=await prepareAction('database_write',{databaseId:'db',sql:'UPDATE games SET banner=null',reason:'Update'},context())
  const old=project.databases[0].host
  project.databases[0].host='different.example'
  try{await assert.rejects(prepared.execute(signal()),/connection changed/)}finally{project.databases[0].host=old}
  const remote=await prepareAction('ssh_execute',{serverId:'server',command:'touch /srv/approved',sudo:true,reason:'Create'},context())
  const before=commands.length
  assert.equal(commands.length,before)
  await remote.execute(signal())
  assert.equal(commands.length,before+1)
  assert.equal(commands.at(-1)[1],'touch /srv/approved')
  assert.equal(commands.at(-1)[2],true)
})

test('local reads need no write permission; writes show new contents and refuse outside paths or changed files',async(t)=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hety-actions-'))
  t.after(async()=>{assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temporary,{recursive:true,force:true})})
  await fs.writeFile(path.join(temporary,'existing.txt'),'before')
  const ctx=context({cwd:temporary})
  assert.equal((await inspectLocal(temporary,{operation:'read_file',path:'existing.txt'})).content,'before')
  const prepared=await prepareAction('local_write',{path:'existing.txt',content:'after',reason:'Update text'},ctx)
  assert.equal(await fs.readFile(path.join(temporary,'existing.txt'),'utf8'),'before')
  assert.equal(prepared.review.details,'after')
  await fs.writeFile(path.join(temporary,'existing.txt'),'changed externally')
  await assert.rejects(prepared.execute(signal()),/file changed/)
  const created=await prepareAction('local_write',{path:'new/nested/file.txt',content:'approved',reason:'Create text'},ctx)
  await created.execute(signal())
  assert.equal(await fs.readFile(path.join(temporary,'new/nested/file.txt'),'utf8'),'approved')
  await assert.rejects(prepareAction('local_write',{path:'../outside.txt',content:'no',reason:'Escape'},ctx),/outside/)
  await assert.rejects(prepareAction('local_write',{path:'x.txt',content:'no',reason:'No folder'},context()),/working folder/)
  const controller=new AbortController();controller.abort()
  const cancelled=await prepareAction('local_write',{path:'cancelled.txt',content:'no',reason:'Cancel'},ctx)
  await assert.rejects(cancelled.execute(controller.signal),/stopped/)
  await assert.rejects(fs.stat(path.join(temporary,'cancelled.txt')),/ENOENT/)
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'hety-outside-'))
  t.after(async()=>{assert.ok(path.resolve(outside).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(outside,{recursive:true,force:true})})
  await fs.symlink(outside,path.join(temporary,'link'),process.platform==='win32'?'junction':'dir')
  await assert.rejects(prepareAction('local_write',{path:'link/escape.txt',content:'no',reason:'Escape link'},ctx),/outside/)
})

test('SFTP uploads validate attached file hashes and show destination before transferring',async(t)=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hety-uploads-'))
  t.after(async()=>{assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temporary,{recursive:true,force:true})})
  const local=path.join(temporary,'banner.png');await fs.writeFile(local,Buffer.from([0,1,2,3]))
  const attachment=await attachmentAt(local),ctx=context({attachments:[attachment]})
  const prepared=await prepareAction('ssh_upload',{serverId:'server',fileId:attachment.id,remotePath:'/srv/banner.png',reason:'Upload banner'},ctx)
  assert.match(prepared.review.details,new RegExp(attachment.sha256))
  assert.match(prepared.review.target,/\/srv\/banner.png/)
  const before=transfers.length
  assert.equal(transfers.length,before)
  const result=await prepared.execute(signal())
  assert.equal(result.bytes,4)
  assert.deepEqual(transfers.at(-1).chunk,Buffer.from([0,1,2,3]))
  assert.equal(ssh.config.password,'SSH_SECRET')
  assert.equal(ssh.destroyed,true)
  await fs.writeFile(local,Buffer.from([4,5,6,7]))
  await assert.rejects(prepared.execute(signal()),/file changed/)
  assert.equal(transfers.length,before+1)
  await assert.rejects(prepareAction('ssh_upload',{serverId:'server',fileId:'other',remotePath:'/srv/banner.png',reason:'Upload'},ctx),/not found/)
})

test('HTTP reads are usable with all writes disabled; prepared PUTs and multipart uploads send only when executed',async(t)=>{
  const requests=[]
  const listener=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk)
    requests.push({method:req.method,url:req.url,body:Buffer.concat(chunks).toString(),headers:req.headers})
    if(req.url==='/redirect'){res.writeHead(307,{Location:'/elsewhere'}).end();return}
    if(req.url==='/failure'){res.writeHead(400).end('Bad request');return}
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true}))
  })
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve))
  t.after(()=>{listener.closeAllConnections();listener.close()})
  const url=`http://127.0.0.1:${listener.address().port}`
  const read=await prepareAction('http_request',{url:url+'/read',method:'GET',reason:'Read'},context({permissions:Object.fromEntries(Object.keys(permissions).map(key=>[key,false]))}))
  assert.equal((await read.execute(signal())).status,200)
  const write=await prepareAction('http_request',{url:url+'/games/7',method:'PUT',headers:{'Content-Type':'application/json','Authorization':'Bearer SECRET'},body:'{"banner":"approved.png"}',reason:'Update'},context())
  const count=requests.length
  assert.equal(requests.length,count)
  assert.ok(!write.review.details.includes('Bearer SECRET'))
  assert.match(write.review.target,/PUT.*games\/7/)
  assert.equal((await write.execute(signal())).success,true)
  assert.equal(requests.length,count+1)
  assert.equal(requests.at(-1).body,'{"banner":"approved.png"}')
  assert.equal(requests.at(-1).headers.authorization,'Bearer SECRET')
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hety-http-'))
  t.after(async()=>{assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temporary,{recursive:true,force:true})})
  const local=path.join(temporary,'banner.png');await fs.writeFile(local,'IMAGE_DATA')
  const attachment=await attachmentAt(local)
  const upload=await prepareAction('http_upload',{url:url+'/upload',fileId:attachment.id,fieldName:'banner',fields:{gameId:'7'},reason:'Upload banner'},context({attachments:[attachment]}))
  assert.equal((await upload.execute(signal())).success,true)
  assert.match(requests.at(-1).body,/filename="banner.png"/)
  assert.match(requests.at(-1).body,/Content-Type: image\/png/)
  assert.match(requests.at(-1).body,/IMAGE_DATA/)
  const redirect=await prepareAction('http_request',{url:url+'/redirect',method:'PUT',body:'{}',reason:'Redirect'},context())
  await assert.rejects(redirect.execute(signal()))
  assert.ok(!requests.some(req=>req.url==='/elsewhere'))
  const failed=await prepareAction('http_request',{url:url+'/failure',method:'DELETE',reason:'Fail'},context())
  assert.equal((await failed.execute(signal())).success,false)
  await assert.rejects(prepareAction('http_request',{url:'file:///C:/private',method:'GET',reason:'Bad protocol'},context()),/HTTP/)
  await assert.rejects(prepareAction('http_request',{url:'https://user:pass@example.test',method:'GET',reason:'Bad credentials'},context()),/embedded/)
})

test('approved local commands run with explicit arguments and hidden windows',async(t)=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hety-command-'))
  t.after(async()=>{assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temporary,{recursive:true,force:true})})
  const target=path.join(temporary,'approved.txt')
  const args=['-e',"require('node:fs').writeFileSync(process.argv[1], process.argv[2])",target,'literal & $(text)']
  const prepared=await prepareAction('local_execute',{executable:process.execPath,args,reason:'Create file'},context({cwd:temporary}))
  await assert.rejects(fs.stat(target),/ENOENT/)
  assert.ok(prepared.review.details.includes('literal & $(text)'))
  assert.equal((await prepared.execute(signal())).success,true)
  assert.equal(await fs.readFile(target,'utf8'),'literal & $(text)')
})
