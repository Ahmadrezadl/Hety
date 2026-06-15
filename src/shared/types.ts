export type AuthType = 'password' | 'key'

export interface Server {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  keyPath?: string
  keyPassphrase?: string
  /** optional accent color (hex) to flag e.g. production. */
  color?: string
}

export interface Database {
  id: string
  name: string
  /** Only 'postgresql' supported in this version. */
  kind: 'postgresql'
  host: string
  port: number
  database: string
  username: string
  password: string
  useSsh: boolean
  /** id of a Server within the same project used as the SSH tunnel host. */
  sshServerId?: string
  /** optional accent color (hex) to flag e.g. production. */
  color?: string
  /** when true the connection is read-only — no writes/deletes until unlocked. */
  locked?: boolean
  createdAt: number
}

export interface Project {
  id: string
  name: string
  description: string
  group: string
  tags: string[]
  /** local filesystem path used by the Repository tab (optional). */
  repoPath: string
  servers: Server[]
  databases: Database[]
  createdAt: number
  lastOpenedAt: number
}

export interface SavedQuery {
  id: string
  name: string
  sql: string
  projectId?: string
  databaseId?: string
  createdAt: number
}

export interface AppData {
  version: number
  projects: Project[]
  savedQueries: SavedQuery[]
  settings: Record<string, unknown>
}

export function emptyAppData(): AppData {
  return { version: 1, projects: [], savedQueries: [], settings: {} }
}

// ---- DB query / schema ----
export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  elapsedMs: number
  command?: string
}

export interface SchemaColumn {
  name: string
  type: string
  pk: boolean
}
export interface SchemaTable {
  name: string
  columns: SchemaColumn[]
}
export interface SchemaEnum {
  name: string
  values: string[]
}
export interface SchemaNamespace {
  name: string
  tables: SchemaTable[]
  views: SchemaTable[]
  enums: SchemaEnum[]
}
export interface DbSchema {
  schemas: SchemaNamespace[]
}

// ---- Git ----
export interface GitFile {
  path: string
  code: string // M, A, D, R, ? ...
}
export interface GitCommit {
  hash: string
  message: string
  author: string
  date: string
  relative: string
}
export interface GitStatus {
  isRepo: boolean
  branch: string
  branches: string[]
  remoteBranches: string[]
  ahead: number
  behind: number
  staged: GitFile[]
  unstaged: GitFile[]
  error?: string
}

export interface RowChanges {
  updates: { where: Record<string, unknown>; set: Record<string, unknown> }[]
  deletes: { where: Record<string, unknown> }[]
}

export interface Ok<T = undefined> {
  ok: true
  data?: T
}
export interface Err {
  ok: false
  error: string
}
export type Result<T = undefined> = Ok<T> | Err
