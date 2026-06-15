import { useState, type ReactNode } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import type { Database, Project } from '@shared/types'
import { useApp, newId } from '../../store'
import { Button, Field, Input, Modal, Spinner, ColorPicker } from '../../lib/ui'

export default function DatabaseDialog({
  project,
  database,
  onClose
}: {
  project: Project
  database?: Database
  onClose: () => void
}): ReactNode {
  const upsertDatabase = useApp((s) => s.upsertDatabase)

  const [name, setName] = useState(database?.name ?? '')
  const [host, setHost] = useState(database?.host ?? 'localhost')
  const [port, setPort] = useState(database?.port ?? 5432)
  const [dbName, setDbName] = useState(database?.database ?? '')
  const [username, setUsername] = useState(database?.username ?? 'postgres')
  const [password, setPassword] = useState(database?.password ?? '')
  const [useSsh, setUseSsh] = useState(database?.useSsh ?? false)
  const [sshServerId, setSshServerId] = useState(database?.sshServerId ?? project.servers[0]?.id ?? '')
  const [color, setColor] = useState<string | undefined>(database?.color)

  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [forceSave, setForceSave] = useState(false)

  const build = (): Database => ({
    id: database?.id ?? newId(),
    name: name.trim(),
    kind: 'postgresql',
    host: host.trim(),
    port: Number(port) || 5432,
    database: dbName.trim(),
    username: username.trim(),
    password,
    useSsh,
    sshServerId: useSsh ? sshServerId : undefined,
    color,
    locked: database?.locked ?? false,
    createdAt: database?.createdAt ?? Date.now()
  })

  const test = async (): Promise<boolean> => {
    setTesting(true)
    setResult(null)
    const db = build()
    const server = useSsh ? project.servers.find((s) => s.id === sshServerId) : undefined
    if (useSsh && !server) {
      setTesting(false)
      setResult({ ok: false, text: 'Select an SSH server for the tunnel.' })
      return false
    }
    const r = await window.api.db.test(db, server)
    setTesting(false)
    if (r.ok) {
      setResult({ ok: true, text: `Connected — ${r.data}` })
      return true
    }
    setResult({ ok: false, text: r.error })
    setForceSave(true)
    return false
  }

  const save = async (): Promise<void> => {
    if (!name.trim() || !dbName.trim()) return
    if (!forceSave) {
      const ok = await test()
      if (!ok) return
    }
    upsertDatabase(project.id, build())
    onClose()
  }

  const noServers = project.servers.length === 0

  return (
    <Modal title={database ? 'Edit database' : 'Add database'} onClose={onClose} width={560}>
      <div className="space-y-4">
        <div className="rounded-lg bg-bg-elevated px-3 py-2 text-[11px] text-ink-faint">
          PostgreSQL · this version supports Postgres connections.
        </div>

        <Field label="Display name">
          <Input autoFocus placeholder="Production DB" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Color" hint="Flag important connections (e.g. red for production).">
          <ColorPicker value={color} onChange={setColor} />
        </Field>

        <div className="grid grid-cols-[1fr,110px] gap-3">
          <Field label="Host">
            <Input value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field label="Port">
            <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </Field>
        </div>

        <Field label="Database">
          <Input placeholder="app" value={dbName} onChange={(e) => setDbName(e.target.value)} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={useSsh}
            disabled={noServers}
            onChange={(e) => setUseSsh(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Connect through an SSH tunnel
          {noServers && <span className="text-[11px] text-ink-faint">(add a server first)</span>}
        </label>

        {useSsh && (
          <Field label="SSH server">
            <select
              value={sshServerId}
              onChange={(e) => setSshServerId(e.target.value)}
              className="field-input"
            >
              {project.servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.username}@{s.host})
                </option>
              ))}
            </select>
          </Field>
        )}

        {result && (
          <div
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
              result.ok ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'
            }`}
          >
            {result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            <span className="break-all">{result.text}</span>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button variant="ghost" onClick={test} disabled={testing}>
            {testing ? <Spinner /> : 'Test Connection'}
          </Button>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!name.trim() || !dbName.trim() || testing} onClick={save}>
              {forceSave ? 'Save anyway' : 'Test & Save'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
