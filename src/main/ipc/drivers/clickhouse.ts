import { createClient, type ClickHouseClient } from '@clickhouse/client'
import type { DbSchema, SchemaNamespace, SchemaTable } from '@shared/types'
import type { ConnectParams, DbDriver, RawResult } from './types'

const READ_RE = /^\s*(select|with|show|desc|describe|explain|exists|values|check)\b/i

interface CompactJson {
  meta?: { name: string; type: string }[]
  data?: unknown[][]
  rows?: number
}

async function introspect(client: ClickHouseClient, database: string): Promise<DbSchema> {
  const db = database || 'default'
  const ns: SchemaNamespace = { name: db, tables: [], views: [], enums: [] }
  const index = new Map<string, SchemaTable>()

  const tablesRs = await client.query({
    query: `SELECT name, engine FROM system.tables WHERE database = {db:String} ORDER BY name`,
    query_params: { db },
    format: 'JSONEachRow'
  })
  const tables = (await tablesRs.json()) as { name: string; engine: string }[]
  for (const t of tables) {
    const obj: SchemaTable = { name: t.name, columns: [] }
    if (/view/i.test(t.engine)) ns.views.push(obj)
    else ns.tables.push(obj)
    index.set(t.name, obj)
  }

  const colsRs = await client.query({
    query: `SELECT table, name, type FROM system.columns WHERE database = {db:String} ORDER BY table, position`,
    query_params: { db },
    format: 'JSONEachRow'
  })
  const cols = (await colsRs.json()) as { table: string; name: string; type: string }[]
  for (const c of cols) {
    // ClickHouse has no unique row keys, so columns are not editable (pk stays false).
    index.get(c.table)?.columns.push({ name: c.name, type: c.type, pk: false })
  }

  return { schemas: [ns] }
}

export async function createClickHouse(p: ConnectParams): Promise<DbDriver> {
  const client = createClient({
    url: `http://${p.host}:${p.port}`,
    username: p.username || 'default',
    password: p.password ?? '',
    database: p.database || 'default',
    request_timeout: 60000
  })
  try {
    const ping = await client.query({ query: 'SELECT 1', format: 'JSONCompact' })
    await ping.json()
  } catch (e) {
    await client.close().catch(() => undefined)
    throw new Error(`ClickHouse: ${(e as Error).message}`)
  }

  return {
    query: async (sql): Promise<RawResult> => {
      const stmt = sql.trim().replace(/;\s*$/, '')
      if (READ_RE.test(stmt)) {
        const rs = await client.query({ query: stmt, format: 'JSONCompact' })
        const json = (await rs.json()) as CompactJson
        return {
          columns: (json.meta ?? []).map((m) => m.name),
          rows: (json.data ?? []) as unknown[][],
          rowCount: json.rows ?? json.data?.length ?? 0
        }
      }
      await client.command({ query: stmt })
      return { columns: [], rows: [], rowCount: 0, command: 'OK' }
    },
    introspect: () => introspect(client, p.database),
    applyChanges: async (): Promise<{ inserted: number; updated: number; deleted: number }> => {
      throw new Error('Row editing is not supported for ClickHouse.')
    },
    setReadOnly: async (): Promise<void> => {
      // ClickHouse read-only is a per-query setting; the app-level lock handles this.
    },
    version: async (): Promise<string> => {
      const rs = await client.query({ query: 'SELECT version()', format: 'JSONCompact' })
      const json = (await rs.json()) as CompactJson
      return `ClickHouse ${String(json.data?.[0]?.[0] ?? '')}`.trim()
    },
    close: async (): Promise<void> => {
      await client.close()
    }
  }
}
