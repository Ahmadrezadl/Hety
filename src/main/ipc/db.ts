import { ipcMain } from 'electron'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { Client as PgClient, types as pgTypes } from 'pg'
import { Client as SshClient } from 'ssh2'

// Return date/time values as the raw DB text instead of JS Date, so timestamps
// aren't silently shifted by the local timezone before they reach the grid.
// 1082=date 1083=time 1114=timestamp 1184=timestamptz 1266=timetz
for (const oid of [1082, 1083, 1114, 1184, 1266]) {
  pgTypes.setTypeParser(oid, (v) => v)
}
import { connectConfig } from './ssh'
import type {
  Database,
  Server,
  Result,
  QueryResult,
  DbSchema,
  SchemaNamespace,
  RowChanges
} from '@shared/types'

interface Tunnel {
  localPort: number
  close: () => void
}
interface Connection {
  client: PgClient
  tunnel?: Tunnel
}

const connections = new Map<string, Connection>()

function createTunnel(server: Server, remoteHost: string, remotePort: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient()
    let settled = false
    conn.on('ready', () => {
      const srv = net.createServer((sock) => {
        conn.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err, stream) => {
          if (err) {
            sock.destroy()
            return
          }
          sock.pipe(stream).pipe(sock)
          sock.on('error', () => stream.end())
          stream.on('error', () => sock.destroy())
        })
      })
      srv.on('error', (e) => {
        if (!settled) {
          settled = true
          reject(e)
        }
      })
      srv.listen(0, '127.0.0.1', () => {
        const localPort = (srv.address() as net.AddressInfo).port
        settled = true
        resolve({
          localPort,
          close: () => {
            try {
              srv.close()
            } catch {
              /* ignore */
            }
            try {
              conn.end()
            } catch {
              /* ignore */
            }
          }
        })
      })
    })
    conn.on('error', (e) => {
      if (!settled) {
        settled = true
        reject(new Error(`SSH tunnel: ${e.message}`))
      }
    })
    try {
      conn.connect(connectConfig(server))
    } catch (e) {
      reject(e as Error)
    }
  })
}

async function openConnection(
  db: Database,
  server?: Server
): Promise<Connection> {
  let tunnel: Tunnel | undefined
  let host = db.host
  let port = db.port
  if (db.useSsh) {
    if (!server) throw new Error('SSH tunnel selected but no SSH server provided.')
    tunnel = await createTunnel(server, db.host, db.port)
    host = '127.0.0.1'
    port = tunnel.localPort
  }
  const client = new PgClient({
    host,
    port,
    database: db.database,
    user: db.username,
    password: db.password,
    connectionTimeoutMillis: 12000,
    statement_timeout: 0
  })
  try {
    await client.connect()
  } catch (e) {
    tunnel?.close()
    throw new Error(`PostgreSQL: ${(e as Error).message}`)
  }
  return { client, tunnel }
}

function cellToValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex')
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

async function introspect(client: PgClient): Promise<DbSchema> {
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

  return {
    schemas: [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}

export function registerDbIpc(): void {
  ipcMain.handle(
    'db:test',
    async (_e, { db, server }: { db: Database; server?: Server }): Promise<Result<string>> => {
      let conn: Connection | undefined
      try {
        conn = await openConnection(db, server)
        const res = await conn.client.query('SELECT version()')
        const version = String(res.rows[0]?.version ?? 'PostgreSQL')
        return { ok: true, data: version.split(',')[0] }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      } finally {
        try {
          await conn?.client.end()
        } catch {
          /* ignore */
        }
        conn?.tunnel?.close()
      }
    }
  )

  ipcMain.handle(
    'db:connect',
    async (_e, { db, server }: { db: Database; server?: Server }): Promise<Result<string>> => {
      try {
        const conn = await openConnection(db, server)
        const id = randomUUID()
        connections.set(id, conn)
        conn.client.on('error', () => disconnect(id))
        return { ok: true, data: id }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle(
    'db:query',
    async (_e, { id, sql }: { id: string; sql: string }): Promise<Result<QueryResult>> => {
      const conn = connections.get(id)
      if (!conn) return { ok: false, error: 'Not connected.' }
      try {
        const start = Date.now()
        const res = await conn.client.query<unknown[]>({ text: sql, rowMode: 'array' })
        const elapsedMs = Date.now() - start
        const columns = (res.fields ?? []).map((f) => f.name)
        const rows = (res.rows ?? []).map((row) => row.map(cellToValue))
        return {
          ok: true,
          data: {
            columns,
            rows,
            rowCount: res.rowCount ?? rows.length,
            elapsedMs,
            command: res.command
          }
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('db:introspect', async (_e, { id }: { id: string }): Promise<Result<DbSchema>> => {
    const conn = connections.get(id)
    if (!conn) return { ok: false, error: 'Not connected.' }
    try {
      return { ok: true, data: await introspect(conn.client) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(
    'db:applyChanges',
    async (
      _e,
      { id, table, changes }: { id: string; table: string; changes: RowChanges }
    ): Promise<Result<{ updated: number; deleted: number }>> => {
      const conn = connections.get(id)
      if (!conn) return { ok: false, error: 'Not connected.' }
      const client = conn.client
      try {
        await client.query('BEGIN')
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
        return { ok: true, data: { updated, deleted } }
      } catch (e) {
        try {
          await client.query('ROLLBACK')
        } catch {
          /* ignore */
        }
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle(
    'db:setReadOnly',
    async (_e, { id, readOnly }: { id: string; readOnly: boolean }): Promise<Result> => {
      const conn = connections.get(id)
      if (!conn) return { ok: false, error: 'Not connected.' }
      try {
        await conn.client.query(
          `SET SESSION default_transaction_read_only = ${readOnly ? 'on' : 'off'}`
        )
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('db:disconnect', (_e, { id }: { id: string }) => {
    disconnect(id)
    return { ok: true }
  })
}

function disconnect(id: string): void {
  const conn = connections.get(id)
  if (!conn) return
  conn.client.end().catch(() => undefined)
  conn.tunnel?.close()
  connections.delete(id)
}
