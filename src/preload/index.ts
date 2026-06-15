import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppData,
  Server,
  Database,
  Result,
  QueryResult,
  DbSchema,
  GitStatus,
  GitCommit,
  GitGraphCommit,
  GitFile,
  MergeMode,
  RowChanges
} from '@shared/types'

type SshStatus = { id: string; status: 'connected' | 'closed' | 'error'; message?: string }
type SshData = { id: string; data: string }

const api = {
  store: {
    getStatus: (): Promise<{ exists: boolean; encrypted: boolean }> =>
      ipcRenderer.invoke('store:getStatus'),
    unlock: (password: string | null): Promise<Result<AppData>> =>
      ipcRenderer.invoke('store:unlock', password),
    create: (password: string | null): Promise<Result<AppData>> =>
      ipcRenderer.invoke('store:create', password),
    save: (data: AppData): Promise<Result> => ipcRenderer.invoke('store:save', data),
    setEncryption: (enabled: boolean, password: string | null): Promise<Result> =>
      ipcRenderer.invoke('store:setEncryption', { enabled, password }),
    path: (): Promise<string> => ipcRenderer.invoke('store:path')
  },
  ssh: {
    open: (server: Server, cols?: number, rows?: number): Promise<string> =>
      ipcRenderer.invoke('ssh:open', { server, cols, rows }),
    input: (id: string, data: string): void => ipcRenderer.send('ssh:input', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('ssh:resize', { id, cols, rows }),
    close: (id: string): void => ipcRenderer.send('ssh:close', { id }),
    onData: (cb: (p: SshData) => void): (() => void) => {
      const listener = (_e: unknown, p: SshData): void => cb(p)
      ipcRenderer.on('ssh:data', listener)
      return () => ipcRenderer.removeListener('ssh:data', listener)
    },
    onStatus: (cb: (p: SshStatus) => void): (() => void) => {
      const listener = (_e: unknown, p: SshStatus): void => cb(p)
      ipcRenderer.on('ssh:status', listener)
      return () => ipcRenderer.removeListener('ssh:status', listener)
    }
  },
  db: {
    test: (db: Database, server?: Server): Promise<Result<string>> =>
      ipcRenderer.invoke('db:test', { db, server }),
    connect: (db: Database, server?: Server): Promise<Result<string>> =>
      ipcRenderer.invoke('db:connect', { db, server }),
    query: (id: string, sql: string): Promise<Result<QueryResult>> =>
      ipcRenderer.invoke('db:query', { id, sql }),
    introspect: (id: string): Promise<Result<DbSchema>> =>
      ipcRenderer.invoke('db:introspect', { id }),
    applyChanges: (
      id: string,
      table: string,
      changes: RowChanges
    ): Promise<Result<{ updated: number; deleted: number }>> =>
      ipcRenderer.invoke('db:applyChanges', { id, table, changes }),
    setReadOnly: (id: string, readOnly: boolean): Promise<Result> =>
      ipcRenderer.invoke('db:setReadOnly', { id, readOnly }),
    disconnect: (id: string): Promise<Result> => ipcRenderer.invoke('db:disconnect', { id })
  },
  git: {
    status: (path: string): Promise<Result<GitStatus>> => ipcRenderer.invoke('git:status', path),
    log: (path: string): Promise<Result<GitCommit[]>> => ipcRenderer.invoke('git:log', path),
    graphLog: (path: string): Promise<Result<GitGraphCommit[]>> =>
      ipcRenderer.invoke('git:graphLog', path),
    commitFiles: (path: string, hash: string): Promise<Result<GitFile[]>> =>
      ipcRenderer.invoke('git:commitFiles', { path, hash }),
    diff: (
      path: string,
      params: { hash?: string; file: string; staged?: boolean; untracked?: boolean }
    ): Promise<Result<string>> => ipcRenderer.invoke('git:diff', { path, ...params }),
    stage: (path: string, files: string[]): Promise<Result> =>
      ipcRenderer.invoke('git:stage', { path, files }),
    stageAll: (path: string): Promise<Result> => ipcRenderer.invoke('git:stageAll', path),
    unstage: (path: string, files: string[]): Promise<Result> =>
      ipcRenderer.invoke('git:unstage', { path, files }),
    unstageAll: (path: string): Promise<Result> => ipcRenderer.invoke('git:unstageAll', path),
    discard: (path: string, files: string[]): Promise<Result> =>
      ipcRenderer.invoke('git:discard', { path, files }),
    commit: (path: string, message: string): Promise<Result> =>
      ipcRenderer.invoke('git:commit', { path, message }),
    checkout: (path: string, branch: string): Promise<Result> =>
      ipcRenderer.invoke('git:checkout', { path, branch }),
    checkoutRemote: (path: string, ref: string): Promise<Result> =>
      ipcRenderer.invoke('git:checkoutRemote', { path, ref }),
    fetch: (path: string): Promise<Result> => ipcRenderer.invoke('git:fetch', path),
    pull: (path: string): Promise<Result> => ipcRenderer.invoke('git:pull', path),
    push: (path: string): Promise<Result> => ipcRenderer.invoke('git:push', path),
    merge: (
      path: string,
      source: string,
      opts?: { into?: string; mode?: MergeMode }
    ): Promise<Result> => ipcRenderer.invoke('git:merge', { path, source, ...opts }),
    createBranch: (
      path: string,
      name: string,
      checkout?: boolean,
      startPoint?: string
    ): Promise<Result> =>
      ipcRenderer.invoke('git:createBranch', { path, name, checkout, startPoint }),
    renameBranch: (path: string, from: string, to: string): Promise<Result> =>
      ipcRenderer.invoke('git:renameBranch', { path, from, to }),
    deleteBranch: (path: string, name: string, force?: boolean): Promise<Result> =>
      ipcRenderer.invoke('git:deleteBranch', { path, name, force }),
    cherryPick: (path: string, hash: string): Promise<Result> =>
      ipcRenderer.invoke('git:cherryPick', { path, hash }),
    revert: (path: string, hash: string): Promise<Result> =>
      ipcRenderer.invoke('git:revert', { path, hash }),
    addTag: (
      path: string,
      name: string,
      opts?: { ref?: string; message?: string; push?: boolean }
    ): Promise<Result> => ipcRenderer.invoke('git:addTag', { path, name, ...opts }),
    deleteTag: (path: string, name: string): Promise<Result> =>
      ipcRenderer.invoke('git:deleteTag', { path, name }),
    clone: (url: string, directory: string, name: string): Promise<Result<string>> =>
      ipcRenderer.invoke('git:clone', { url, directory, name })
  },
  app: {
    saveFile: (defaultName: string, content: string): Promise<Result<string>> =>
      ipcRenderer.invoke('app:saveFile', { defaultName, content }),
    pickFile: (): Promise<string | null> => ipcRenderer.invoke('app:pickFile'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('app:pickFolder'),
    openPath: (path: string): Promise<Result> => ipcRenderer.invoke('app:openPath', path),
    openEditor: (command: string, path: string): Promise<Result> =>
      ipcRenderer.invoke('app:openEditor', { command, path }),
    openTerminal: (path: string): Promise<Result> => ipcRenderer.invoke('app:openTerminal', path)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
