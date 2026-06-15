import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { Result } from '@shared/types'

export function registerAppIpc(): void {
  ipcMain.handle(
    'app:saveFile',
    async (e, { defaultName, content }: { defaultName: string; content: string }): Promise<Result<string>> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const { canceled, filePath } = await dialog.showSaveDialog(win!, { defaultPath: defaultName })
      if (canceled || !filePath) return { ok: false, error: 'Cancelled' }
      try {
        await fs.writeFile(filePath, content, 'utf8')
        return { ok: true, data: filePath }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('app:pickFile', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, { properties: ['openFile'] })
    return canceled || !filePaths.length ? null : filePaths[0]
  })

  ipcMain.handle('app:pickFolder', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return canceled || !filePaths.length ? null : filePaths[0]
  })

  ipcMain.handle('app:openPath', async (_e, path: string): Promise<Result> => {
    const err = await shell.openPath(path)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle(
    'app:openEditor',
    (_e, { command, path }: { command: string; path: string }): Result => {
      try {
        const child = spawn(command, [path], { detached: true, stdio: 'ignore', shell: true })
        child.on('error', () => undefined)
        child.unref()
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
