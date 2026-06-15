import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerStoreIpc } from './ipc/store'
import { registerSshIpc } from './ipc/ssh'
import { registerDbIpc } from './ipc/db'
import { registerGitIpc } from './ipc/git'
import { registerAppIpc } from './ipc/app'

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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
