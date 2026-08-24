import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import * as store from './lib/store'
import { registerStoreIpc } from './ipc/store'
import { registerSshIpc } from './ipc/ssh'
import { registerDbIpc } from './ipc/db'
import { registerGitIpc } from './ipc/git'
import { registerAppIpc } from './ipc/app'
import { registerOpsIpc } from './ipc/ops'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0e0f13',
    title: 'Hety',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerStoreIpc()
  registerSshIpc()
  registerDbIpc()
  registerGitIpc()
  registerAppIpc()
  registerOpsIpc()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Absorb stray idle-connection errors that some drivers may still emit during teardown.
process.on('uncaughtException', (err) => {
  const msg = err?.message ?? String(err)
  if (
    /Connection terminated unexpectedly/i.test(msg) ||
    /Connection lost/i.test(msg) ||
    /ECONNRESET|EPIPE|ETIMEDOUT/i.test(msg)
  ) {
    console.warn('[hety] ignored idle connection error:', msg)
    return
  }
  console.error('[hety] uncaughtException:', err)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Saves are debounced in the main process, so quitting has to wait for the last
// one to reach disk instead of dropping it.
let flushing = false
app.on('before-quit', (e) => {
  if (flushing || !store.hasPendingWrite()) return
  e.preventDefault()
  flushing = true
  store
    .flush()
    .catch(() => undefined)
    .then(() => app.quit())
})
