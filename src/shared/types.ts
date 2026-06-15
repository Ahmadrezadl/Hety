import type { DatabaseKind } from './databases'

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
  kind: DatabaseKind
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

/** A local Git working copy managed under a project. */
export interface Repository {
  id: string
  name: string
  path: string
}

// ---- Planning board (Kanban) ----
export interface BoardCard {
  id: string
  title: string
  description?: string
  createdAt: number
}
export interface BoardColumn {
  id: string
  name: string
  /** optional accent color (hex). */
  color?: string
  /** when true, a card dropped onto this column is deleted (trash/done-and-archive). */
  deleteOnDrop?: boolean
  cards: BoardCard[]
}
export interface Board {
  columns: BoardColumn[]
}

export interface Project {
  id: string
  name: string
  description: string
  group: string
  tags: string[]
  /** optional emoji shown as the project's icon. */
  icon?: string
  /** Git repositories managed in the Repository tab (zero or more). */
  repositories: Repository[]
  /** @deprecated legacy single-repo path; migrated into `repositories` on load. */
  repoPath?: string
  /** planning board (Kanban) for this project. */
  board?: Board
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
/** A commit enriched with parent/ref data for drawing a branch graph. */
export interface GitGraphCommit {
  hash: string
  parents: string[]
  message: string
  author: string
  email: string
  /** ISO commit date. */
  date: string
  relative: string
  /** commit body (after the subject line). */
  body: string
  refs: string[]
}

export type MergeMode = 'default' | 'no-ff' | 'squash' | 'no-commit'
export interface GitStatus {
  isRepo: boolean
  /** false when the configured repoPath no longer exists on disk. */
  exists: boolean
  branch: string
  branches: string[]
  remoteBranches: string[]
  tags: string[]
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
