export const DATABASE_KINDS = [
  'postgresql',
  'mysql',
  'mariadb',
  'sqlite',
  'sqlserver',
  'mongodb',
  'redis'
] as const

export type DatabaseKind = (typeof DATABASE_KINDS)[number]

export interface DatabaseKindInfo {
  kind: DatabaseKind
  name: string
  aliases: string[]
  category: 'relational' | 'document' | 'key-value'
  defaultPort: number
  defaultDatabase: string
  defaultUsername: string
  supportsHost: boolean
  supportsAuth: boolean
  supportsSsh: boolean
  supported: boolean
}

export const DATABASE_KIND_INFO: Record<DatabaseKind, DatabaseKindInfo> = {
  postgresql: {
    kind: 'postgresql',
    name: 'PostgreSQL',
    aliases: ['postgres', 'pg', 'sql'],
    category: 'relational',
    defaultPort: 5432,
    defaultDatabase: '',
    defaultUsername: 'postgres',
    supportsHost: true,
    supportsAuth: true,
    supportsSsh: true,
    supported: true
  },
  mysql: {
    kind: 'mysql',
    name: 'MySQL',
    aliases: ['mysql server', 'sql'],
    category: 'relational',
    defaultPort: 3306,
    defaultDatabase: '',
    defaultUsername: 'root',
    supportsHost: true,
    supportsAuth: true,
    supportsSsh: true,
    supported: false
  },
  mariadb: {
    kind: 'mariadb',
    name: 'MariaDB',
    aliases: ['maria', 'mysql-compatible', 'sql'],
    category: 'relational',
    defaultPort: 3306,
    defaultDatabase: '',
    defaultUsername: 'root',
    supportsHost: true,
    supportsAuth: true,
    supportsSsh: true,
    supported: false
  },
  sqlite: {
    kind: 'sqlite',
    name: 'SQLite',
    aliases: ['sqlite3', 'file database', 'embedded'],
    category: 'relational',
    defaultPort: 0,
    defaultDatabase: '',
    defaultUsername: '',
    supportsHost: false,
    supportsAuth: false,
    supportsSsh: false,
    supported: false
  },
  sqlserver: {
    kind: 'sqlserver',
    name: 'SQL Server',
    aliases: ['mssql', 'ms sql', 'microsoft sql server'],
    category: 'relational',
    defaultPort: 1433,
    defaultDatabase: '',
    defaultUsername: 'sa',
    supportsHost: true,
    supportsAuth: true,
    supportsSsh: true,
    supported: false
  },
  mongodb: {
    kind: 'mongodb',
    name: 'MongoDB',
    aliases: ['mongo', 'document database', 'nosql'],
    category: 'document',
    defaultPort: 27017,
    defaultDatabase: '',
    defaultUsername: '',
    supportsHost: true,
    supportsAuth: true,
    supportsSsh: true,
    supported: false
  },
  redis: {
    kind: 'redis',
    name: 'Redis',
    aliases: ['cache', 'key value', 'kv'],
    category: 'key-value',
    defaultPort: 6379,
    defaultDatabase: '0',
    defaultUsername: '',
    supportsHost: true,
    supportsAuth: true,
    supportsSsh: true,
    supported: false
  }
}

export const DATABASE_KIND_LIST = DATABASE_KINDS.map((kind) => DATABASE_KIND_INFO[kind])

export function getDatabaseKindInfo(kind?: DatabaseKind | string): DatabaseKindInfo {
  if (kind && kind in DATABASE_KIND_INFO) return DATABASE_KIND_INFO[kind as DatabaseKind]
  return DATABASE_KIND_INFO.postgresql
}

export function isSupportedDatabaseKind(kind?: DatabaseKind | string): boolean {
  return getDatabaseKindInfo(kind).supported
}
