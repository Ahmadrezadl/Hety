import { useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, CheckCircle2, Search, XCircle } from 'lucide-react'
import type { Database, Project } from '@shared/types'
import type { DatabaseKind, DatabaseKindInfo } from '@shared/databases'
import { DATABASE_KIND_LIST, getDatabaseKindInfo } from '@shared/databases'
import { useApp, newId } from '../../store'
import { Button, Field, Input, Modal, Spinner, ColorPicker, cn } from '../../lib/ui'
import DatabaseLogo from '../db/DatabaseLogo'

type Step = 'kind' | 'details'

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

  const initialKind = getDatabaseKindInfo(database?.kind).kind
  const [step, setStep] = useState<Step>(database ? 'details' : 'kind')
  const [kind, setKind] = useState<DatabaseKind>(initialKind)
  const kindInfo = getDatabaseKindInfo(kind)

  const [name, setName] = useState(database?.name ?? '')
  const [host, setHost] = useState(database?.host ?? 'localhost')
  const [port, setPort] = useState(database?.port ?? kindInfo.defaultPort)
  const [dbName, setDbName] = useState(database?.database ?? kindInfo.defaultDatabase)
  const [username, setUsername] = useState(database?.username ?? kindInfo.defaultUsername)
  const [password, setPassword] = useState(database?.password ?? '')
  const [useSsh, setUseSsh] = useState(database?.useSsh ?? false)
  const [sshServerId, setSshServerId] = useState(database?.sshServerId ?? project.servers[0]?.id ?? '')
  const [color, setColor] = useState<string | undefined>(database?.color)

  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [forceSave, setForceSave] = useState(false)

  const chooseKind = (next: DatabaseKind): void => {
    const info = getDatabaseKindInfo(next)
    setKind(next)
    setResult(null)
    setForceSave(false)
    if (!database) {
      setPort(info.defaultPort)
      setDbName(info.defaultDatabase)
      setUsername(info.defaultUsername)
      setUseSsh(false)
    }
  }

  const build = (): Database => ({
    id: database?.id ?? newId(),
    name: name.trim(),
    kind,
    host: kindInfo.supportsHost ? host.trim() : '',
    port: kindInfo.supportsHost ? Number(port) || kindInfo.defaultPort : 0,
    database: dbName.trim(),
    username: kindInfo.supportsAuth ? username.trim() : '',
    password: kindInfo.supportsAuth ? password : '',
    useSsh: kindInfo.supportsSsh ? useSsh : false,
    sshServerId: kindInfo.supportsSsh && useSsh ? sshServerId : undefined,
    color,
    locked: database?.locked ?? false,
    createdAt: database?.createdAt ?? Date.now()
  })

  const test = async (): Promise<boolean> => {
    if (!kindInfo.supported) {
      setResult({
        ok: false,
        text: `${kindInfo.name} profiles can be saved, but live connections are not wired in this build yet.`
      })
      return false
    }

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
      setResult({ ok: true, text: `Connected - ${r.data}` })
      return true
    }
    setResult({ ok: false, text: r.error })
    setForceSave(true)
    return false
  }

  const save = async (): Promise<void> => {
    if (!canSave) return
    if (kindInfo.supported && !forceSave) {
      const ok = await test()
      if (!ok) return
    }
    upsertDatabase(project.id, build())
    onClose()
  }

  const noServers = project.servers.length === 0
  const requiresDatabase = kind !== 'redis'
  const canSave = !!name.trim() && (!requiresDatabase || !!dbName.trim())
  const dbLabel = kind === 'sqlite' ? 'Database file' : kind === 'redis' ? 'Database index' : 'Database'
  const dbPlaceholder =
    kind === 'sqlite' ? 'C:\\data\\app.db' : kind === 'redis' ? '0' : kind === 'mongodb' ? 'admin' : 'app'

  if (step === 'kind') {
    return (
      <DatabaseKindStep
        selected={kind}
        onSelect={chooseKind}
        onClose={onClose}
        onContinue={() => setStep('details')}
      />
    )
  }

  return (
    <Modal title={database ? 'Edit database' : 'Add database'} onClose={onClose} width={600}>
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-lg border border-line bg-bg-elevated px-3 py-2">
          {!database && (
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-bg-hover hover:text-ink"
              title="Choose another type"
              onClick={() => setStep('kind')}
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <DatabaseLogo kind={kind} size={34} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold">{kindInfo.name}</span>
              <span
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase',
                  kindInfo.supported ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'
                )}
              >
                {kindInfo.supported ? 'Ready' : 'Profile only'}
              </span>
            </div>
            <div className="text-[11px] text-ink-faint">
              {kindInfo.supported
                ? 'Live connection, schema browsing, query console, and edits are available.'
                : 'You can save this connection profile now. Live drivers can be wired in later.'}
            </div>
          </div>
        </div>

        <Field label="Display name">
          <Input autoFocus placeholder="Production DB" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Color" hint="Flag important connections, for example red for production.">
          <ColorPicker value={color} onChange={setColor} />
        </Field>

        {kindInfo.supportsHost && (
          <div className="grid grid-cols-[1fr,110px] gap-3">
            <Field label="Host">
              <Input value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <Field label="Port">
              <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
            </Field>
          </div>
        )}

        <Field label={dbLabel}>
          <Input placeholder={dbPlaceholder} value={dbName} onChange={(e) => setDbName(e.target.value)} />
        </Field>

        {kindInfo.supportsAuth && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        )}

        {kindInfo.supportsSsh && (
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
        )}

        {kindInfo.supportsSsh && useSsh && (
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
          {kindInfo.supported && (
            <Button variant="ghost" onClick={test} disabled={testing}>
              {testing ? <Spinner /> : 'Test Connection'}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!canSave || testing} onClick={save}>
              {kindInfo.supported ? (forceSave ? 'Save anyway' : 'Test & Save') : 'Save profile'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function DatabaseKindStep({
  selected,
  onSelect,
  onClose,
  onContinue
}: {
  selected: DatabaseKind
  onSelect: (kind: DatabaseKind) => void
  onClose: () => void
  onContinue: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const selectedInfo = getDatabaseKindInfo(selected)

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return DATABASE_KIND_LIST
    return DATABASE_KIND_LIST.filter((info) =>
      [info.name, info.category, info.kind, ...info.aliases].some((part) =>
        part.toLowerCase().includes(q)
      )
    )
  }, [query])

  return (
    <Modal title="Choose database type" onClose={onClose} width={720}>
      <div className="space-y-4">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-ink-faint" />
          <input
            autoFocus
            className="w-full rounded-lg border border-line bg-bg-input py-2 pl-9 pr-3 text-[13px] outline-none placeholder:text-ink-faint focus:border-accent"
            placeholder="Search database types"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2.5">
          {filtered.map((info) => (
            <DatabaseKindCard
              key={info.kind}
              info={info}
              active={selected === info.kind}
              onClick={() => onSelect(info.kind)}
              onDoubleClick={() => {
                onSelect(info.kind)
                onContinue()
              }}
            />
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="rounded-lg border border-line bg-bg-elevated px-3 py-8 text-center text-xs text-ink-faint">
            No database types match your search.
          </div>
        )}

        <div className="rounded-lg bg-bg-elevated px-3 py-2 text-[11px] text-ink-faint">
          {selectedInfo.supported
            ? `${selectedInfo.name} is fully supported in this build.`
            : `${selectedInfo.name} can be saved as a profile; live connection support is not wired yet.`}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onContinue}>Continue</Button>
        </div>
      </div>
    </Modal>
  )
}

function DatabaseKindCard({
  info,
  active,
  onClick,
  onDoubleClick
}: {
  info: DatabaseKindInfo
  active: boolean
  onClick: () => void
  onDoubleClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        'flex min-h-[86px] items-center gap-3 rounded-lg border bg-bg-panel p-3 text-left transition-colors',
        active ? 'border-accent bg-accent-dim' : 'border-line hover:border-accent hover:bg-bg-elevated'
      )}
    >
      <DatabaseLogo kind={info.kind} size={38} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold">{info.name}</span>
        <span className="mt-0.5 block text-[11px] capitalize text-ink-faint">{info.category}</span>
        <span
          className={cn(
            'mt-2 inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
            info.supported ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'
          )}
        >
          {info.supported ? 'Ready' : 'Profile'}
        </span>
      </span>
    </button>
  )
}
