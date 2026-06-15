import { ipcMain } from 'electron'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { Client as SshClient } from 'ssh2'
import { connectConfig } from './ssh'
import type { Database, Server, Result, QueryResult, DbSchema, RowChanges } from '@shared/types'
import { getDatabaseKindInfo } from '@shared/databases'
import { createDriver, type DbDriver } from './drivers'

interface Tunnel {
  localPort: number
  close: () => void
}
interface Connection {
  driver: DbDriver
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

async function openConnection(db: Database, server?: Server): Promise<Connection> {
  const info = getDatabaseKindInfo(db.kind)
  if (!info.supported) {
    throw new Error(`${info.name} connections are not available in this build yet.`)
  }

  let tunnel: Tunnel | undefined
  let host = db.host
  let port = db.port
  if (db.useSsh) {
    if (!server) throw new Error('SSH tunnel selected but no SSH server provided.')
    tunnel = await createTunnel(server, db.host, db.port)
    host = '127.0.0.1'
    port = tunnel.localPort
  }

  try {
    const driver = await createDriver(db.kind, {
      host,
      port,
      database: db.database,
      username: db.username,
      password: db.password
    })
    return { driver, tunnel }
  } catch (e) {
    tunnel?.close()
    throw e
  }
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

export function registerDbIpc(): void {
  ipcMain.handle(
    'db:test',
    async (_e, { db, server }: { db: Database; server?: Server }): Promise<Result<string>> => {
      let conn: Connection | undefined
      try {
        conn = await openConnection(db, server)
        const version = await conn.driver.version()
        return { ok: true, data: version }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      } finally {
        try {
          await conn?.driver.close()
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
        const raw = await conn.driver.query(sql)
        const elapsedMs = Date.now() - start
        return {
          ok: true,
          data: {
            columns: raw.columns,
            rows: raw.rows.map((row) => row.map(cellToValue)),
            rowCount: raw.rowCount,
            elapsedMs,
            command: raw.command
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
      return { ok: true, data: await conn.driver.introspect() }
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
      try {
        return { ok: true, data: await conn.driver.applyChanges(table, changes) }
      } catch (e) {
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
        await conn.driver.setReadOnly(readOnly)
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
  conn.driver.close().catch(() => undefined)
  conn.tunnel?.close()
  connections.delete(id)
}
