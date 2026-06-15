import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AppData, emptyAppData } from '@shared/types'
import * as vault from './crypto'

let dataPath = ''
let current: AppData = emptyAppData()
let password: string | null = null
let encrypted = false

function file(): string {
  if (!dataPath) dataPath = path.join(app.getPath('userData'), 'hety-data.dat')
  return dataPath
}

export async function getStatus(): Promise<{ exists: boolean; encrypted: boolean }> {
  try {
    const buf = await fs.readFile(file())
    return { exists: true, encrypted: vault.isEncrypted(buf) }
  } catch {
    return { exists: false, encrypted: false }
  }
}

export async function unlock(pw: string | null): Promise<AppData> {
  const buf = await fs.readFile(file())
  const plain = vault.decrypt(buf, pw ?? '')
  current = JSON.parse(plain.toString('utf8')) as AppData
  encrypted = vault.isEncrypted(buf)
  password = encrypted ? pw : null
  return current
}

export async function create(pw: string | null): Promise<AppData> {
  current = emptyAppData()
  password = pw && pw.length ? pw : null
  encrypted = !!password
  await persist()
  return current
}

export function getData(): AppData {
  return current
}

export async function save(data: AppData): Promise<void> {
  current = data
  await persist()
}

export async function setEncryption(enabled: boolean, pw: string | null): Promise<void> {
  encrypted = enabled
  password = enabled ? pw : null
  await persist()
}

async function persist(): Promise<void> {
  const plain = Buffer.from(JSON.stringify(current), 'utf8')
  const out = encrypted && password ? vault.encrypt(plain, password) : vault.packPlain(plain)
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), out)
}

export function dataFilePath(): string {
  return file()
}
