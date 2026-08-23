import type { DatabaseKind } from './databases'

/** SQL flavour that determines identifier quoting and row-limit syntax. */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlserver' | 'clickhouse'

export function dialectOf(kind: DatabaseKind | string): SqlDialect {
  switch (kind) {
    case 'mysql':
    case 'mariadb':
      return 'mysql'
    case 'sqlserver':
      return 'sqlserver'
    case 'clickhouse':
      return 'clickhouse'
    default:
      return 'postgres'
  }
}

/** Quote a single identifier for the given database kind. */
export function quoteIdent(kind: DatabaseKind | string, name: string): string {
  switch (dialectOf(kind)) {
    case 'mysql':
    case 'clickhouse':
      return '`' + name.replace(/`/g, '``') + '`'
    case 'sqlserver':
      return '[' + name.replace(/]/g, ']]') + ']'
    default:
      return '"' + name.replace(/"/g, '""') + '"'
  }
}

/** Quote a dotted, qualified name (e.g. schema.table), dropping empty parts. */
export function quoteQualified(kind: DatabaseKind | string, ...parts: string[]): string {
  return parts
    .filter((p) => p != null && p !== '')
    .map((p) => quoteIdent(kind, p))
    .join('.')
}

export interface TableQueryOpts {
  where?: string
  orderBy?: string
  limit?: number
}

/** Build a table preview SELECT with optional WHERE / ORDER BY. */
export function buildTableQuery(
  kind: DatabaseKind | string,
  schema: string,
  table: string,
  opts: TableQueryOpts = {}
): string {
  const limit = opts.limit ?? 200
  const qualified = quoteQualified(kind, schema, table)
  const where = opts.where?.trim()
  const orderBy = opts.orderBy?.trim()
  let sql: string
  if (dialectOf(kind) === 'sqlserver') {
    sql = `SELECT TOP ${limit} * FROM ${qualified}`
  } else {
    sql = `SELECT * FROM ${qualified}`
  }
  if (where) sql += ` WHERE ${where}`
  if (orderBy) sql += ` ORDER BY ${orderBy}`
  if (dialectOf(kind) !== 'sqlserver') sql += ` LIMIT ${limit}`
  return `${sql};`
}

/** Build a "preview the first N rows" SELECT for the given dialect. */
export function buildSelectAll(
  kind: DatabaseKind | string,
  schema: string,
  table: string,
  limit = 200
): string {
  return buildTableQuery(kind, schema, table, { limit })
}
