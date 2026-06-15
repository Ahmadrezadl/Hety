import { ipcMain, BrowserWindow } from 'electron'
import { Client as SshClient, type ClientChannel, type ConnectConfig } from 'ssh2'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Server } from '@shared/types'

interface Session {
  client: SshClient
  stream?: ClientChannel
}

const sessions = new Map<string, Session>()

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function connectConfig(server: Server): ConnectConfig {
  const cfg: ConnectConfig = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000
  }
  if (server.authType === 'key' && server.keyPath) {
    cfg.privateKey = readFileSync(server.keyPath)
    if (server.keyPassphrase) cfg.passphrase = server.keyPassphrase
  } else {
    cfg.password = server.password
    cfg.tryKeyboard = true
  }
  return cfg
}

function cleanup(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.stream?.end()
  } catch {
    /* ignore */
  }
  try {
    s.client.end()
  } catch {
    /* ignore */
  }
  sessions.delete(id)
}

export function registerSshIpc(): void {
  ipcMain.handle(
    'ssh:open',
    (_e, { server, cols, rows }: { server: Server; cols?: number; rows?: number }): string => {
      const id = randomUUID()
      const client = new SshClient()
      sessions.set(id, { client })

      client.on('ready', () => {
        client.shell(
          { term: 'xterm-256color', cols: cols || 120, rows: rows || 30 },
          (err, stream) => {
            if (err) {
              broadcast('ssh:status', { id, status: 'error', message: err.message })
              return
            }
            const s = sessions.get(id)
            if (!s) {
              stream.end()
              return
            }
            s.stream = stream
            broadcast('ssh:status', { id, status: 'connected' })
            stream.on('data', (d: Buffer) => broadcast('ssh:data', { id, data: d.toString('utf8') }))
            stream.stderr.on('data', (d: Buffer) =>
              broadcast('ssh:data', { id, data: d.toString('utf8') })
            )
            stream.on('close', () => {
              broadcast('ssh:status', { id, status: 'closed' })
              cleanup(id)
            })
          }
        )
      })

      client.on('keyboard-interactive', (_n, _i, _il, _p, finish) => {
        finish([server.password || ''])
      })
      client.on('error', (err) => broadcast('ssh:status', { id, status: 'error', message: err.message }))
      client.on('close', () => broadcast('ssh:status', { id, status: 'closed' }))

      try {
        client.connect(connectConfig(server))
      } catch (e) {
        broadcast('ssh:status', { id, status: 'error', message: (e as Error).message })
      }
      return id
    }
  )

  ipcMain.on('ssh:input', (_e, { id, data }: { id: string; data: string }) => {
    sessions.get(id)?.stream?.write(data)
  })

  ipcMain.on('ssh:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    try {
      sessions.get(id)?.stream?.setWindow(rows, cols, 0, 0)
    } catch {
      /* ignore */
    }
  })

  ipcMain.on('ssh:close', (_e, { id }: { id: string }) => cleanup(id))
}

export { connectConfig }
