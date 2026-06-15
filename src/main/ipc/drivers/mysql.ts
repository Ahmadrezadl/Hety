import mysql from 'mysql2/promise'
import type { DbSchema, SchemaNamespace, SchemaTable, RowChanges } from '@shared/types'
import type { ConnectParams, DbDriver, RawResult } from './types'

const q = (name: string): string => '`' + name.replace(/`/g, '``') + '`'

interface TableRow {
  n: string
  t: string
}
interface ColumnRow {
  t: string
  c: string
  d: string
  k: string
}

async function resolveSchema(conn: mysql.Connection, database: string): Promise<string> {
  if (database) return database
  const [rows] = await conn.query('SELECT DATABASE() AS d')
  return (rows as Array<{ d: string | null }>)[0]?.d ?? ''
}

async function introspect(conn: mysql.Connection, database: string): Promise<DbSchema> {
  const schemaName = await resolveSchema(conn, database)
  const ns: SchemaNamespace = { name: schemaName || 'database', tables: [], views: [], enums: [] }
  const index = new Map<string, SchemaTable>()

  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS n, TABLE_TYPE AS t
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [schemaName]
  )
  for (const r of tables as TableRow[]) {
    const obj: SchemaTable = { name: r.n, columns: [] }
    if (r.t === 'VIEW') ns.views.push(obj)
    else ns.tables.push(obj)
    index.set(r.n, obj)
  }

  const [cols] = await conn.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS d, COLUMN_KEY AS k
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? ORDER BY ORDINAL_POSITION`,
    [schemaName]
  )
  for (const r of cols as ColumnRow[]) {
    index.get(r.t)?.columns.push({ name: r.c, type: r.d, pk: r.k === 'PRI' })
  }

  return { schemas: [ns] }
}

async function applyChanges(
  conn: mysql.Connection,
  table: string,
  changes: RowChanges
): Promise<{ updated: number; deleted: number }> {
  await conn.beginTransaction()
  try {
    let updated = 0
    let deleted = 0

    for (const u of changes.updates) {
      const setCols = Object.keys(u.set)
      const whereCols = Object.keys(u.where)
      if (!setCols.length || !whereCols.length) continue
      const params: unknown[] = []
      const setSql = setCols
        .map((c) => {
          params.push(u.set[c])
          return `${q(c)} = ?`
        })
        .join(', ')
      const whereSql = whereCols
        .map((c) => {
          params.push(u.where[c])
          return `${q(c)} = ?`
        })
        .join(' AND ')
      const [res] = await conn.query(`UPDATE ${table} SET ${setSql} WHERE ${whereSql}`, params)
      updated += (res as mysql.ResultSetHeader).affectedRows ?? 0
    }

    for (const d of changes.deletes) {
      const whereCols = Object.keys(d.where)
      if (!whereCols.length) continue
      const params: unknown[] = []
      const whereSql = whereCols
        .map((c) => {
          params.push(d.where[c])
          return `${q(c)} = ?`
        })
        .join(' AND ')
      const [res] = await conn.query(`DELETE FROM ${table} WHERE ${whereSql}`, params)
      deleted += (res as mysql.ResultSetHeader).affectedRows ?? 0
    }

    await conn.commit()
    return { updated, deleted }
  } catch (e) {
    await conn.rollback().catch(() => undefined)
    throw e
  }
}

export async function createMysql(p: ConnectParams, label: string): Promise<DbDriver> {
  let conn: mysql.Connection
  try {
    conn = await mysql.createConnection({
      host: p.host,
      port: p.port,
      user: p.username,
      password: p.password,
      database: p.database || undefined,
      connectTimeout: 12000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false
    })
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`)
  }

  return {
    query: async (sql): Promise<RawResult> => {
      const [rows, fields] = await conn.query({ sql, rowsAsArray: true })
      if (Array.isArray(rows)) {
        const columns = ((fields as mysql.FieldPacket[]) ?? []).map((f) => f.name)
        return { columns, rows: rows as unknown[][], rowCount: (rows as unknown[][]).length }
      }
      const header = rows as mysql.ResultSetHeader
      return { columns: [], rows: [], rowCount: header.affectedRows ?? 0, command: 'OK' }
    },
    introspect: () => introspect(conn, p.database),
    applyChanges: (table, changes) => applyChanges(conn, table, changes),
    setReadOnly: async (): Promise<void> => {
      // MySQL has no easily-set session read-only that blocks writes; the app-level
      // lock disables grid edits, which is what enforces read-only here.
    },
    version: async (): Promise<string> => {
      const [rows] = await conn.query('SELECT VERSION() AS v')
      const v = (rows as Array<{ v: string }>)[0]?.v ?? ''
      return `${label} ${v}`.trim()
    },
    close: async (): Promise<void> => {
      await conn.end()
    }
  }
}
