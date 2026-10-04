import type { DatabaseKind } from './databases'

export type AuthType = 'password' | 'key'

/** A saved shell command, runnable into any terminal open on its server. */
export interface Snippet {
  id: string
  name: string
  command: string
  /** when true, sending the snippet also presses Enter instead of only typing it. */
  autoRun?: boolean
  createdAt: number
}

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
  /**
   * Password for `sudo` on this host, used by the Remote tab for privileged
   * actions. Falls back to `password` when empty.
   */
  sudoPassword?: string
  /** optional accent color (hex) to flag e.g. production. */
  color?: string
  /** saved commands for this host, offered in its terminal toolbar. */
  snippets?: Snippet[]
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

/** One executed statement, logged so it can be found and re-run later. */
export interface QueryHistoryEntry {
  id: string
  sql: string
  projectId?: string
  databaseId?: string
  /** Database name as of the run, so history stays readable after a delete. */
  databaseName?: string
  ranAt: number
  elapsedMs: number
  /** Rows returned or affected; absent when the statement failed. */
  rowCount?: number
  error?: string
}

/** Newest-first cap on the history log, to bound the size of the vault. */
export const QUERY_HISTORY_LIMIT = 500

export interface AppData {
  version: number
  projects: Project[]
  savedQueries: SavedQuery[]
  queryHistory: QueryHistoryEntry[]
  settings: Record<string, unknown>
}

export function emptyAppData(): AppData {
  return { version: 1, projects: [], savedQueries: [], queryHistory: [], settings: {} }
}

// ---- DB query / schema ----
export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  elapsedMs: number
  command?: string
}

/** The column a foreign key points at. */
export interface ColumnRef {
  /** owning schema; omitted for engines with a single namespace. */
  schema?: string
  table: string
  column: string
}

export interface SchemaColumn {
  name: string
  type: string
  pk: boolean
  /** set when the column is a foreign key, naming the referenced column. */
  ref?: ColumnRef
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

/** A saved entry from `git stash list`. */
export interface GitStash {
  /** position in the stash stack (0 = most recent). */
  index: number
  /** reflog selector, e.g. `stash@{0}`. */
  ref: string
  /** human description (the part after "WIP on <branch>:" / "On <branch>:"). */
  message: string
  /** branch the stash was created on, best-effort. */
  branch: string
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

// ---- Remote server ops (Remote tab) ----

/** Identity of a connected remote host plus what privileges we have on it. */
export interface RemoteHostInfo {
  hostname: string
  os: string
  kernel: string
  user: string
  home: string
  isRoot: boolean
  /** true when `sudo` exists and we can elevate (passwordless or with the saved password). */
  canSudo: boolean
  shell: string
}

export type RemoteEntryType = 'dir' | 'file' | 'link' | 'other'

export interface RemoteEntry {
  name: string
  path: string
  type: RemoteEntryType
  size: number
  /** modification time in ms since epoch. */
  mtime: number
  /** permission bits, e.g. 0o755. */
  mode: number
  /** `rwxr-xr-x` rendering of `mode`. */
  modeText: string
  owner: string
  group: string
  /** for symlinks: whether the target resolves to a directory. */
  linkDir?: boolean
}

export interface RemoteListing {
  path: string
  entries: RemoteEntry[]
  /** true when the listing had to be read with elevated privileges. */
  elevated?: boolean
}

export interface RemoteFile {
  path: string
  content: string
  size: number
  /** true when only the first slice of a large file was read. */
  truncated: boolean
  /** true when the content looks binary (rendered read-only). */
  binary: boolean
}

export interface RemoteBinary {
  path: string
  /** base64 payload, capped at 16 MB. */
  base64: string
  size: number
  truncated: boolean
}

export interface RemoteExec {
  code: number
  stdout: string
  stderr: string
}

/** What an upload actually put on the server, so the UI can word its toast. */
export interface UploadSummary {
  files: number
  folders: number
}

export type TransferKind = 'upload' | 'download'
export interface TransferProgress {
  serverId: string
  kind: TransferKind
  name: string
  transferred: number
  total: number
  /** 1-based position in a multi-file transfer. */
  index: number
  count: number
  done: boolean
  error?: string
}

// ---- Monitoring ----
export interface CpuCore {
  id: string
  usage: number
}
export interface DiskUsage {
  filesystem: string
  type: string
  mount: string
  size: number
  used: number
  available: number
  usePercent: number
}
export interface ProcessInfo {
  pid: number
  user: string
  cpu: number
  mem: number
  rss: number
  name: string
  command: string
}
export interface NetInterface {
  name: string
  rxBytes: number
  txBytes: number
  /** bytes/second since the previous sample (0 on the first one). */
  rxRate: number
  txRate: number
}
export interface RemoteMetrics {
  time: number
  hostname: string
  os: string
  kernel: string
  uptimeSeconds: number
  load: [number, number, number]
  cpu: { usage: number; count: number; cores: CpuCore[]; temperature?: number }
  memory: { total: number; used: number; available: number; cached: number; buffers: number }
  swap: { total: number; used: number }
  disks: DiskUsage[]
  net: NetInterface[]
  processes: ProcessInfo[]
  processCount: number
  sessions: { user: string; tty: string; from: string; since: string }[]
}

// ---- Security ----
export interface UfwRule {
  num: number
  to: string
  action: string
  from: string
  comment?: string
}
export interface UfwStatus {
  installed: boolean
  active: boolean
  /** e.g. `deny (incoming), allow (outgoing)`. */
  defaults: string
  logging: string
  rules: UfwRule[]
}
export interface ListeningPort {
  proto: string
  address: string
  port: string
  process: string
  pid?: number
}
export interface Fail2banJail {
  name: string
  currentlyFailed: number
  totalFailed: number
  banned: string[]
  totalBanned: number
}
export interface AuditItem {
  key: string
  value: string
  /** true = hardened, false = risky, null = informational. */
  status: boolean | null
  advice?: string
}
export interface LoginRecord {
  user: string
  from: string
  when: string
  failed: boolean
}
export interface SecurityReport {
  /** false when the data below was collected without root (partial results). */
  elevated: boolean
  ufw: UfwStatus
  /** another firewall was detected instead of ufw (firewalld / nftables). */
  otherFirewall?: string
  ports: ListeningPort[]
  fail2ban: { installed: boolean; jails: Fail2banJail[] }
  sshd: AuditItem[]
  logins: LoginRecord[]
}
export interface UpdateReport {
  manager: string
  total: number
  security: number
  packages: string[]
}

// ---- Services ----
export interface ServiceUnit {
  name: string
  load: string
  active: string
  sub: string
  description: string
  /** enabled / disabled / static / masked, from list-unit-files. */
  startup: string
}

// ---- Docker ----
export interface DockerContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
}
export interface DockerImage {
  id: string
  repository: string
  tag: string
  size: string
  created: string
}
export interface DockerReport {
  installed: boolean
  /** false when the daemon is unreachable or we lack permission. */
  accessible: boolean
  message?: string
  containers: DockerContainer[]
  images: DockerImage[]
}

// ---- PM2 ----
export type Pm2Scope = 'user' | 'root'
export type Pm2Action = 'restart' | 'reload' | 'stop' | 'delete'
export interface Pm2Process {
  id: number
  pid: number
  name: string
  namespace: string
  status: string
  mode: string
  cpu: number
  memory: number
  uptime: number
  restarts: number
  script: string
  cwd: string
}
export interface Pm2Instance {
  scope: Pm2Scope
  user: string
  installed: boolean
  accessible: boolean
  home: string
  binary: string
  message?: string
  processes: Pm2Process[]
}
export interface Pm2Report {
  installed: boolean
  instances: Pm2Instance[]
  /** Both accounts returned the same process list; display it only once. */
  sameList: boolean
}

export interface RowChanges {
  inserts: { values: Record<string, unknown> }[]
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
