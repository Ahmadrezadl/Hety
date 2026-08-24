import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppData,
  Server,
  Database,
  Result,
  QueryResult,
  DbSchema,
  ColumnRef,
  GitStatus,
  GitCommit,
  GitGraphCommit,
  GitFile,
  GitStash,
  MergeMode,
  RowChanges,
  RemoteHostInfo,
  RemoteListing,
  RemoteFile,
  RemoteBinary,
  RemoteExec,
  RemoteMetrics,
  SecurityReport,
  UpdateReport,
  ServiceUnit,
  DockerReport,
  TransferProgress
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
    relatedRows: (
      id: string,
      ref: ColumnRef,
      value: unknown,
      limit?: number
    ): Promise<Result<QueryResult>> =>
      ipcRenderer.invoke('db:relatedRows', { id, ref, value, limit }),
    applyChanges: (
      id: string,
      table: string,
      changes: RowChanges
    ): Promise<Result<{ inserted: number; updated: number; deleted: number }>> =>
      ipcRenderer.invoke('db:applyChanges', { id, table, changes }),
    setReadOnly: (id: string, readOnly: boolean): Promise<Result> =>
      ipcRenderer.invoke('db:setReadOnly', { id, readOnly }),
    disconnect: (id: string): Promise<Result> => ipcRenderer.invoke('db:disconnect', { id }),
    onStatus: (
      cb: (p: { id: string; status: 'error' | 'closed'; message?: string }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        p: { id: string; status: 'error' | 'closed'; message?: string }
      ): void => cb(p)
      ipcRenderer.on('db:status', listener)
      return () => ipcRenderer.removeListener('db:status', listener)
    }
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
    stashList: (path: string): Promise<Result<GitStash[]>> =>
      ipcRenderer.invoke('git:stashList', path),
    stashPush: (path: string, message?: string, includeUntracked?: boolean): Promise<Result> =>
      ipcRenderer.invoke('git:stashPush', { path, message, includeUntracked }),
    stashApply: (path: string, ref: string): Promise<Result> =>
      ipcRenderer.invoke('git:stashApply', { path, ref }),
    stashPop: (path: string, ref: string): Promise<Result> =>
      ipcRenderer.invoke('git:stashPop', { path, ref }),
    stashDrop: (path: string, ref: string): Promise<Result> =>
      ipcRenderer.invoke('git:stashDrop', { path, ref }),
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
  /** Remote server management (files, monitoring, security, services, docker). */
  ops: {
    connect: (server: Server): Promise<Result<RemoteHostInfo>> =>
      ipcRenderer.invoke('ops:connect', { server }),
    disconnect: (serverId: string): Promise<Result> =>
      ipcRenderer.invoke('ops:disconnect', { serverId }),
    exec: (server: Server, command: string, root?: boolean): Promise<Result<RemoteExec>> =>
      ipcRenderer.invoke('ops:exec', { server, command, root }),

    fs: {
      home: (server: Server): Promise<Result<string>> => ipcRenderer.invoke('ops:fs:home', { server }),
      list: (server: Server, path: string): Promise<Result<RemoteListing>> =>
        ipcRenderer.invoke('ops:fs:list', { server, path }),
      read: (server: Server, path: string): Promise<Result<RemoteFile>> =>
        ipcRenderer.invoke('ops:fs:read', { server, path }),
      readBinary: (server: Server, path: string): Promise<Result<RemoteBinary>> =>
        ipcRenderer.invoke('ops:fs:readBinary', { server, path }),
      write: (server: Server, path: string, content: string): Promise<Result<null>> =>
        ipcRenderer.invoke('ops:fs:write', { server, path, content }),
      mkdir: (server: Server, path: string): Promise<Result<null>> =>
        ipcRenderer.invoke('ops:fs:mkdir', { server, path }),
      newFile: (server: Server, path: string): Promise<Result<null>> =>
        ipcRenderer.invoke('ops:fs:newFile', { server, path }),
      rename: (server: Server, from: string, to: string): Promise<Result<null>> =>
        ipcRenderer.invoke('ops:fs:rename', { server, from, to }),
      delete: (server: Server, paths: string[]): Promise<Result<null>> =>
        ipcRenderer.invoke('ops:fs:delete', { server, paths }),
      chmod: (
        server: Server,
        path: string,
        mode: string,
        recursive?: boolean
      ): Promise<Result<null>> =>
        ipcRenderer.invoke('ops:fs:chmod', { server, path, mode, recursive }),
      chown: (
        server: Server,
        path: string,
        owner: string,
        recursive?: boolean
      ): Promise<Result<null>> =>
        ipcRenderer.invoke('ops:fs:chown', { server, path, owner, recursive }),
      transfer: (
        server: Server,
        op: 'copy' | 'move',
        sources: string[],
        destDir: string
      ): Promise<Result<null>> =>
        ipcRenderer.invoke('ops:fs:transfer', { server, op, sources, destDir }),
      archive: (
        server: Server,
        paths: string[],
        destDir: string,
        name: string
      ): Promise<Result<string>> =>
        ipcRenderer.invoke('ops:fs:archive', { server, paths, destDir, name }),
      extract: (server: Server, path: string, destDir: string): Promise<Result<null>> =>
        ipcRenderer.invoke('ops:fs:extract', { server, path, destDir }),
      size: (server: Server, path: string): Promise<Result<string>> =>
        ipcRenderer.invoke('ops:fs:size', { server, path }),
      tail: (server: Server, path: string, lines?: number): Promise<Result<string>> =>
        ipcRenderer.invoke('ops:fs:tail', { server, path, lines }),
      upload: (server: Server, remoteDir: string, localPaths?: string[]): Promise<Result<number>> =>
        ipcRenderer.invoke('ops:fs:upload', { server, remoteDir, localPaths }),
      download: (server: Server, path: string, isDir: boolean): Promise<Result<string | null>> =>
        ipcRenderer.invoke('ops:fs:download', { server, path, isDir })
    },

    metrics: (server: Server): Promise<Result<RemoteMetrics>> =>
      ipcRenderer.invoke('ops:metrics', { server }),
    kill: (server: Server, pid: number, signal?: 'TERM' | 'KILL'): Promise<Result<null>> =>
      ipcRenderer.invoke('ops:kill', { server, pid, signal }),

    security: (server: Server): Promise<Result<SecurityReport>> =>
      ipcRenderer.invoke('ops:security', { server }),
    updates: (server: Server): Promise<Result<UpdateReport>> =>
      ipcRenderer.invoke('ops:updates', { server }),
    ufw: (server: Server, args: string): Promise<Result<string>> =>
      ipcRenderer.invoke('ops:ufw', { server, args }),
    fail2banUnban: (server: Server, jail: string, ip: string): Promise<Result<string>> =>
      ipcRenderer.invoke('ops:fail2banUnban', { server, jail, ip }),

    services: (server: Server): Promise<Result<ServiceUnit[]>> =>
      ipcRenderer.invoke('ops:services', { server }),
    serviceAction: (server: Server, unit: string, action: string): Promise<Result<string>> =>
      ipcRenderer.invoke('ops:serviceAction', { server, unit, action }),
    serviceLogs: (server: Server, unit: string, lines?: number): Promise<Result<string>> =>
      ipcRenderer.invoke('ops:serviceLogs', { server, unit, lines }),

    docker: (server: Server): Promise<Result<DockerReport>> =>
      ipcRenderer.invoke('ops:docker', { server }),
    dockerAction: (server: Server, action: string, id: string): Promise<Result<string>> =>
      ipcRenderer.invoke('ops:dockerAction', { server, action, id }),
    dockerLogs: (server: Server, id: string, lines?: number): Promise<Result<string>> =>
      ipcRenderer.invoke('ops:dockerLogs', { server, id, lines }),
    dockerPrune: (
      server: Server,
      target: 'images' | 'containers' | 'system'
    ): Promise<Result<string>> => ipcRenderer.invoke('ops:dockerPrune', { server, target }),

    onProgress: (cb: (p: TransferProgress) => void): (() => void) => {
      const listener = (_e: unknown, p: TransferProgress): void => cb(p)
      ipcRenderer.on('ops:progress', listener)
      return () => ipcRenderer.removeListener('ops:progress', listener)
    },
    onClosed: (cb: (p: { serverId: string }) => void): (() => void) => {
      const listener = (_e: unknown, p: { serverId: string }): void => cb(p)
      ipcRenderer.on('ops:closed', listener)
      return () => ipcRenderer.removeListener('ops:closed', listener)
    },
    /** Local absolute path of a file dropped onto the window (Electron 32+). */
    pathForFile: (file: File): string => webUtils.getPathForFile(file)
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
