import { ipcMain, BrowserWindow } from 'electron'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { Client as SshClient } from 'ssh2'
import { connectConfig } from './ssh'
import type {
  Database,
  Server,
  Result,
  QueryResult,
  DbSchema,
  RowChanges,
  ColumnRef
} from '@shared/types'
import { getDatabaseKindInfo } from '@shared/databases'
import { createDriver, type DbDriver } from './drivers'

interface Tunnel {
  localPort: number
  close: () => void
}
export interface Connection {
  driver: DbDriver
  tunnel?: Tunnel
}

const connections = new Map<string, Connection>()

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function createTunnel(server: Server, remoteHost: string, remotePort: number, signal?: AbortSignal): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient()
    let srv: net.Server | undefined
    let closed = false
    const sockets = new Set<net.Socket>()
    const close = (): void => {
      if (closed) return
      closed = true
      signal?.removeEventListener('abort', abort)
      for (const socket of sockets) socket.destroy()
      srv?.close()
      conn.destroy()
    }
    const abort = (): void => { if (!settled) { settled = true; reject(new Error('Database operation stopped.')) }; close() }
    let settled = false
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => server.password || '')))
    conn.on('ready', () => {
      if (signal?.aborted) { close(); return }
      srv = net.createServer((sock) => {
        sockets.add(sock)
        sock.once('close', () => sockets.delete(sock))
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
          close()
        }
      })
      srv.listen(0, '127.0.0.1', () => {
        if (closed) return
        const localPort = (srv!.address() as net.AddressInfo).port
        settled = true
        resolve({
          localPort,
          close
        })
      })
    })
    conn.on('error', (e) => {
      if (!settled) {
        settled = true
        reject(new Error(`SSH tunnel: ${e.message}`))
        close()
      }
      // After settle, errors are absorbed so Node doesn't treat them as uncaught.
    })
    try {
      conn.connect(connectConfig(server))
    } catch (e) {
      settled = true
      reject(e as Error)
      close()
    }
  })
}

export async function openConnection(
  db: Database,
  server: Server | undefined,
  onIdleError?: (err: Error) => void,
  options: { signal?: AbortSignal; readOnly?: boolean; timeoutMs?: number } = {}
): Promise<Connection> {
  if (options.signal?.aborted) throw new Error('Database operation stopped.')
  const info = getDatabaseKindInfo(db.kind)
  if (!info.supported) {
    throw new Error(`${info.name} connections are not available in this build yet.`)
  }

  let tunnel: Tunnel | undefined
  let host = db.host
  let port = db.port
  if (db.useSsh) {
    if (!server) throw new Error('SSH tunnel selected but no SSH server provided.')
    tunnel = await createTunnel(server, db.host, db.port, options.signal)
    host = '127.0.0.1'
    port = tunnel.localPort
  }

  try {
    const driver = await createDriver(db.kind, {
      host,
      port,
      database: db.database,
      username: db.username,
      password: db.password,
      readOnly: options.readOnly,
      timeoutMs: options.timeoutMs,
      onIdleError
    })
    if (options.signal?.aborted) {
      driver.abort?.()
      void driver.close().catch(() => undefined)
      throw new Error('Database operation stopped.')
    }
    return { driver, tunnel }
  } catch (e) {
    tunnel?.close()
    throw e
  }
}

export function cellToValue(v: unknown): string | number | boolean | null {
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
        conn = await openConnection(db, server, () => undefined)
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
        const id = randomUUID()
        const conn = await openConnection(db, server, (err) => {
          if (!connections.has(id)) return
          broadcast('db:status', {
            id,
            status: 'error',
            message: err.message || 'Connection terminated unexpectedly'
          })
          disconnect(id)
        })
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

  ipcMain.handle(
    'db:relatedRows',
    async (
      _e,
      { id, ref, value, limit }: { id: string; ref: ColumnRef; value: unknown; limit?: number }
    ): Promise<Result<QueryResult>> => {
      const conn = connections.get(id)
      if (!conn) return { ok: false, error: 'Not connected.' }
      try {
        const start = Date.now()
        const raw = await conn.driver.lookupRows(ref, value, Math.min(limit ?? 20, 200))
        return {
          ok: true,
          data: {
            columns: raw.columns,
            rows: raw.rows.map((row) => row.map(cellToValue)),
            rowCount: raw.rowCount,
            elapsedMs: Date.now() - start
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
    ): Promise<Result<{ inserted: number; updated: number; deleted: number }>> => {
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
  connections.delete(id)
  conn.driver.close().catch(() => undefined)
  conn.tunnel?.close()
}
