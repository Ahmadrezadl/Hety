const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const esbuild = require('esbuild')
const postcss = require('postcss')
const tailwind = require('tailwindcss')

test('context access UI supports bulk selection and requires a warning decision before full access', {timeout:30000}, async (t) => {
  const root = path.resolve(__dirname, '..')
  const directory = await fs.mkdtemp(path.join(root, 'out', 'access-ui-'))
  t.after(async () => { await fs.rm(directory, {recursive:true,force:true}) })
  const entry = path.join(directory,'fixture.tsx')
  await fs.writeFile(entry, `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import Settings from ${JSON.stringify(path.join(root,'src/renderer/src/components/ai/ContextAccessSettings.tsx').replaceAll('\\','/'))};
    import {defaultCodexAccess} from '@shared/codexAccess';
    const project={id:'synthetic',name:'Preview',description:'',group:'',tags:[],databases:[{id:'prod',name:'Production',kind:'postgresql',host:'prod.example',port:5432,database:'app'},{id:'dev',name:'Development',kind:'postgresql',host:'localhost',port:5432,database:'app_dev'}],servers:[{id:'server',name:'Production server',host:'server.example',port:22,username:'deploy'}],repositories:[{id:'repo',name:'Application',path:'D:/Projects/Application'}],board:{columns:[{id:'todo',name:'To do',cards:[]}]}};
    function Demo(){const [access,setAccess]=useState(defaultCodexAccess(project));const [disabled,setDisabled]=useState(false);window.fixtureAccess=access;return <main className="flex h-full"><section className="flex flex-1 flex-col justify-center p-12"><h1 className="text-2xl font-semibold">Codex project access</h1><p className="mt-3 text-sm text-ink-soft">Choose what Codex can see and change, one resource at a time.</p><button id="busy" onClick={()=>setDisabled(!disabled)}>Toggle running</button></section><aside className="w-[340px] overflow-auto border-l border-line bg-bg-panel p-4"><Settings project={project} access={access} disabled={disabled} customFolder={true} onChange={setAccess}/></aside></main>};createRoot(document.getElementById('root')).render(<Demo/>);
  `)
  await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'fixture.js'),bundle:true,jsx:'automatic',alias:{'@shared':path.join(root,'src/shared')},define:{'process.env.NODE_ENV':'"production"'}})
  const css = await postcss([tailwind(path.join(root,'tailwind.config.cjs'))]).process(await fs.readFile(path.join(root,'src/renderer/src/index.css'),'utf8'),{from:path.join(root,'src/renderer/src/index.css')})
  await fs.writeFile(path.join(directory,'fixture.css'),css.css)
  await fs.writeFile(path.join(directory,'index.html'),'<html><head><meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const screenshot = path.join(root,'out','access-settings-preview.png')
  await fs.writeFile(path.join(directory,'main.cjs'), `
    const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{const win=new BrowserWindow({width:1100,height:900,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});try{
      await win.loadFile(${JSON.stringify(path.join(directory,'index.html'))});
      const run=async(code)=>{const result=await win.webContents.executeJavaScript(code);await win.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,30))');return result};
      const state=()=>run('window.fixtureAccess');
      const select=async(label,value)=>run('(()=>{const el=document.querySelector('+JSON.stringify('select[aria-label="'+label+'"]')+');el.value='+JSON.stringify(value)+';el.dispatchEvent(new Event("change",{bubbles:true}));})()');
      const button=async(text)=>run('([...document.querySelectorAll("button")].find(el=>el.textContent==='+JSON.stringify(text)+')).click()');
      assert.equal((await state()).databases.prod,'read');
      await button('Deselect all');assert.deepEqual((await state()).databases,{prod:'excluded',dev:'excluded'});
      await button('Select all');assert.deepEqual((await state()).databases,{prod:'read',dev:'read'});
      await select('Access for Production','full');assert.equal((await state()).databases.prod,'read');assert.equal(await run('!!document.querySelector("[role=alertdialog]")'),true);
      await button('Cancel');assert.equal((await state()).databases.prod,'read');
      await select('Access for Production','full');await button('Enable full access');assert.equal((await state()).databases.prod,'full');
      await select('Set access for included databases','read');assert.deepEqual((await state()).databases,{prod:'read',dev:'read'});
      await select('Set access for included databases','full');assert.equal(await run('document.querySelector("[role=alertdialog] ul").children.length'),2);assert.equal((await state()).databases.prod,'read');
      await run('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))');assert.equal(await run('!!document.querySelector("[role=alertdialog]")'),false);
      assert.equal(await run('[...document.querySelectorAll("input")].find(el=>el.getAttribute("aria-label")==="Include Production in Codex context").checked'),true);
      await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const screenshot=await win.webContents.capturePage();fs.writeFileSync(${JSON.stringify(screenshot)},screenshot.toPNG());
      await run('document.getElementById("busy").click()');assert.equal(await run('[...document.querySelectorAll("select")].every(el=>el.disabled)'),true);
      console.log('Access UI interaction checks passed.');
    }catch(error){console.error(error.stack);process.exitCode=1}finally{win.destroy();app.quit()}});
  `)
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'),[path.join(directory,'main.cjs')],{windowsHide:true,env,stdio:['ignore','pipe','pipe']})
  t.after(() => {if(child.exitCode===null)child.kill()})
  let output=''
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk)
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
  assert.equal(code,0,output)
  assert.match(output,/Access UI interaction checks passed/)
})
