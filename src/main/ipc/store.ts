import { ipcMain } from 'electron'
import * as store from '../lib/store'
import type { AppData, Result } from '@shared/types'

export function registerStoreIpc(): void {
  ipcMain.handle('store:getStatus', () => store.getStatus())

  ipcMain.handle('store:unlock', async (_e, pw: string | null): Promise<Result<AppData>> => {
    try {
      return { ok: true, data: await store.unlock(pw) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('store:create', async (_e, pw: string | null): Promise<Result<AppData>> => {
    try {
      return { ok: true, data: await store.create(pw) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('store:save', async (_e, data: AppData): Promise<Result> => {
    try {
      await store.save(data)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(
    'store:setEncryption',
    async (_e, { enabled, password }: { enabled: boolean; password: string | null }): Promise<Result> => {
      try {
        await store.setEncryption(enabled, password)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('store:path', () => store.dataFilePath())
}
