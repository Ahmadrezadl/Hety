import sql from 'mssql'
import type { DbSchema, SchemaNamespace, SchemaTable, RowChanges } from '@shared/types'
import type { ConnectParams, DbDriver, RawResult } from './types'

const q = (name: string): string => '[' + name.replace(/]/g, ']]') + ']'

function sumAffected(rowsAffected: number[] | undefined): number {
  return (rowsAffected ?? []).reduce((a, b) => a + b, 0)
}

async function introspect(pool: sql.ConnectionPool): Promise<DbSchema> {
  const map = new Map<string, SchemaNamespace>()
  const bucket = (name: string): SchemaNamespace => {
    let b = map.get(name)
    if (!b) {
      b = { name, tables: [], views: [], enums: [] }
      map.set(name, b)
    }
    return b
  }

  const tables = await pool.request().query<{ s: string; n: string; t: string }>(
    `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, TABLE_TYPE AS t
     FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`
  )
  const index = new Map<string, SchemaTable>()
  for (const r of tables.recordset) {
    const b = bucket(r.s)
    const obj: SchemaTable = { name: r.n, columns: [] }
    if (r.t === 'VIEW') b.views.push(obj)
    else b.tables.push(obj)
    index.set(`${r.s}.${r.n}`, obj)
  }

  const pks = new Set<string>()
  const pkRows = await pool.request().query<{ s: string; t: string; c: string }>(
    `SELECT tc.TABLE_SCHEMA AS s, tc.TABLE_NAME AS t, kcu.COLUMN_NAME AS c
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
     WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`
  )
  for (const r of pkRows.recordset) pks.add(`${r.s}.${r.t}.${r.c}`)

  const cols = await pool.request().query<{ s: string; t: string; c: string; d: string }>(
    `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d
     FROM INFORMATION_SCHEMA.COLUMNS ORDER BY ORDINAL_POSITION`
  )
  for (const r of cols.recordset) {
    index.get(`${r.s}.${r.t}`)?.columns.push({
      name: r.c,
      type: r.d,
      pk: pks.has(`${r.s}.${r.t}.${r.c}`)
    })
  }

  return { schemas: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

async function applyChanges(
  pool: sql.ConnectionPool,
  table: string,
  changes: RowChanges
): Promise<{ updated: number; deleted: number }> {
  const tx = new sql.Transaction(pool)
  await tx.begin()
  try {
    let updated = 0
    let deleted = 0

    for (const u of changes.updates) {
      const setCols = Object.keys(u.set)
      const whereCols = Object.keys(u.where)
      if (!setCols.length || !whereCols.length) continue
      const req = new sql.Request(tx)
      let i = 0
      const setSql = setCols
        .map((c) => {
          const pn = `p${i++}`
          req.input(pn, u.set[c])
          return `${q(c)} = @${pn}`
        })
        .join(', ')
      const whereSql = whereCols
        .map((c) => {
          const pn = `p${i++}`
          req.input(pn, u.where[c])
          return `${q(c)} = @${pn}`
        })
        .join(' AND ')
      const res = await req.query(`UPDATE ${table} SET ${setSql} WHERE ${whereSql}`)
      updated += sumAffected(res.rowsAffected)
    }

    for (const d of changes.deletes) {
      const whereCols = Object.keys(d.where)
      if (!whereCols.length) continue
      const req = new sql.Request(tx)
      let i = 0
      const whereSql = whereCols
        .map((c) => {
          const pn = `p${i++}`
          req.input(pn, d.where[c])
          return `${q(c)} = @${pn}`
        })
        .join(' AND ')
      const res = await req.query(`DELETE FROM ${table} WHERE ${whereSql}`)
      deleted += sumAffected(res.rowsAffected)
    }

    await tx.commit()
    return { updated, deleted }
  } catch (e) {
    await tx.rollback().catch(() => undefined)
    throw e
  }
}

export async function createSqlServer(p: ConnectParams): Promise<DbDriver> {
  const pool = new sql.ConnectionPool({
    server: p.host,
    port: p.port,
    user: p.username,
    password: p.password,
    database: p.database || undefined,
    connectionTimeout: 12000,
    requestTimeout: 0,
    options: { encrypt: true, trustServerCertificate: true, enableArithAbort: true }
  })
  try {
    await pool.connect()
  } catch (e) {
    throw new Error(`SQL Server: ${(e as Error).message}`)
  }

  return {
    query: async (text): Promise<RawResult> => {
      const req = pool.request()
      req.arrayRowMode = true
      const res = await req.query(text)
      // arrayRowMode adds a `columns` metadata array that isn't in the typings.
      const withMeta = res as unknown as { columns?: Array<Array<{ name?: string }>> }
      const recordset = res.recordset as unknown as unknown[][] | undefined
      if (recordset) {
        const meta = (Array.isArray(withMeta.columns) ? withMeta.columns[0] : undefined) as
          | Array<{ name?: string }>
          | undefined
        const width = recordset[0]?.length ?? meta?.length ?? 0
        const columns = Array.from({ length: width }, (_, i) => meta?.[i]?.name || `col${i + 1}`)
        return { columns, rows: recordset, rowCount: recordset.length }
      }
      return { columns: [], rows: [], rowCount: sumAffected(res.rowsAffected), command: 'OK' }
    },
    introspect: () => introspect(pool),
    applyChanges: (table, changes) => applyChanges(pool, table, changes),
    setReadOnly: async (): Promise<void> => {
      // No session-wide read-only toggle; the app-level lock disables grid edits.
    },
    version: async (): Promise<string> => {
      const res = await pool.request().query<{ v: string }>('SELECT @@VERSION AS v')
      return String(res.recordset[0]?.v ?? 'SQL Server').split('\n')[0].trim()
    },
    close: async (): Promise<void> => {
      await pool.close()
    }
  }
}
