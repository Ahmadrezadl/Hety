import { Client, types as pgTypes } from 'pg'
import type { DbSchema, SchemaNamespace, RowChanges } from '@shared/types'
import type { ConnectParams, DbDriver, RawResult } from './types'

// Return date/time values as the raw DB text instead of JS Date, so timestamps
// aren't silently shifted by the local timezone before they reach the grid.
// 1082=date 1083=time 1114=timestamp 1184=timestamptz 1266=timetz
for (const oid of [1082, 1083, 1114, 1184, 1266]) {
  pgTypes.setTypeParser(oid, (v) => v)
}

async function introspect(client: Client): Promise<DbSchema> {
  const map = new Map<string, SchemaNamespace>()
  const bucket = (name: string): SchemaNamespace => {
    let b = map.get(name)
    if (!b) {
      b = { name, tables: [], views: [], enums: [] }
      map.set(name, b)
    }
    return b
  }

  const schemas = await client.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'`
  )
  for (const r of schemas.rows) bucket(r.schema_name)

  const tables = await client.query<{ s: string; n: string; t: string }>(
    `SELECT table_schema AS s, table_name AS n, table_type AS t
     FROM information_schema.tables
     WHERE table_schema NOT LIKE 'pg_%' AND table_schema <> 'information_schema'
     ORDER BY table_name`
  )
  const tableIndex = new Map<string, { name: string; columns: never[] }>()
  for (const r of tables.rows) {
    const b = bucket(r.s)
    const obj = { name: r.n, columns: [] as never[] }
    if (r.t === 'VIEW') b.views.push(obj)
    else b.tables.push(obj)
    tableIndex.set(`${r.s}.${r.n}`, obj)
  }

  const pks = new Set<string>()
  const pkRows = await client.query<{ s: string; t: string; c: string }>(
    `SELECT tc.table_schema AS s, tc.table_name AS t, kcu.column_name AS c
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'`
  )
  for (const r of pkRows.rows) pks.add(`${r.s}.${r.t}.${r.c}`)

  const cols = await client.query<{ s: string; t: string; c: string; d: string }>(
    `SELECT table_schema AS s, table_name AS t, column_name AS c, data_type AS d
     FROM information_schema.columns
     WHERE table_schema NOT LIKE 'pg_%' AND table_schema <> 'information_schema'
     ORDER BY ordinal_position`
  )
  for (const r of cols.rows) {
    const obj = tableIndex.get(`${r.s}.${r.t}`)
    if (obj)
      (obj.columns as unknown as { name: string; type: string; pk: boolean }[]).push({
        name: r.c,
        type: r.d,
        pk: pks.has(`${r.s}.${r.t}.${r.c}`)
      })
  }

  const enums = await client.query<{ s: string; n: string; v: string }>(
    `SELECT n.nspname AS s, t.typname AS n, e.enumlabel AS v
     FROM pg_type t
     JOIN pg_enum e ON t.oid = e.enumtypid
     JOIN pg_namespace n ON n.oid = t.typnamespace
     ORDER BY e.enumsortorder`
  )
  const enumIndex = new Map<string, { name: string; values: string[] }>()
  for (const r of enums.rows) {
    const key = `${r.s}.${r.n}`
    let en = enumIndex.get(key)
    if (!en) {
      en = { name: r.n, values: [] }
      enumIndex.set(key, en)
      bucket(r.s).enums.push(en)
    }
    en.values.push(r.v)
  }

  return { schemas: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

async function applyChanges(
  client: Client,
  table: string,
  changes: RowChanges
): Promise<{ updated: number; deleted: number }> {
  await client.query('BEGIN')
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
          return `"${c}" = $${params.length}`
        })
        .join(', ')
      const whereSql = whereCols
        .map((c) => {
          params.push(u.where[c])
          return `"${c}" = $${params.length}`
        })
        .join(' AND ')
      const res = await client.query(`UPDATE ${table} SET ${setSql} WHERE ${whereSql}`, params)
      updated += res.rowCount ?? 0
    }

    for (const d of changes.deletes) {
      const whereCols = Object.keys(d.where)
      if (!whereCols.length) continue
      const params: unknown[] = []
      const whereSql = whereCols
        .map((c) => {
          params.push(d.where[c])
          return `"${c}" = $${params.length}`
        })
        .join(' AND ')
      const res = await client.query(`DELETE FROM ${table} WHERE ${whereSql}`, params)
      deleted += res.rowCount ?? 0
    }

    await client.query('COMMIT')
    return { updated, deleted }
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  }
}

export async function createPostgres(p: ConnectParams): Promise<DbDriver> {
  const client = new Client({
    host: p.host,
    port: p.port,
    database: p.database,
    user: p.username,
    password: p.password,
    connectionTimeoutMillis: 12000,
    statement_timeout: 0
  })
  try {
    await client.connect()
  } catch (e) {
    throw new Error(`PostgreSQL: ${(e as Error).message}`)
  }

  return {
    query: async (sql): Promise<RawResult> => {
      const res = await client.query<unknown[]>({ text: sql, rowMode: 'array' })
      return {
        columns: (res.fields ?? []).map((f) => f.name),
        rows: (res.rows ?? []) as unknown[][],
        rowCount: res.rowCount ?? res.rows?.length ?? 0,
        command: res.command
      }
    },
    introspect: () => introspect(client),
    applyChanges: (table, changes) => applyChanges(client, table, changes),
    setReadOnly: async (readOnly): Promise<void> => {
      await client.query(`SET SESSION default_transaction_read_only = ${readOnly ? 'on' : 'off'}`)
    },
    version: async (): Promise<string> => {
      const r = await client.query<{ version: string }>('SELECT version()')
      return String(r.rows[0]?.version ?? 'PostgreSQL').split(',')[0]
    },
    close: async (): Promise<void> => {
      await client.end()
    }
  }
}
