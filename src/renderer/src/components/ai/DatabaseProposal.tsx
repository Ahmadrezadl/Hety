import { useState, type ReactNode } from 'react'
import type { Project, Database } from '@shared/types'
import type { DatabaseApproval } from '@shared/codex'
import { DATABASE_KIND_LIST, getDatabaseKindInfo, type DatabaseKind } from '@shared/databases'
import { Button, Field, Input, PasswordInput } from '../../lib/ui'

export default function DatabaseProposal({ approval, project, busy, onDecision }: {
  approval: DatabaseApproval
  project: Project
  busy: boolean
  onDecision: (database: Database | null) => void
}): ReactNode {
  const [database, setDatabase] = useState(approval.database)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')
  const patch = (fields: Partial<Database>): void => { setDatabase((current) => ({ ...current, ...fields })); setTestResult('') }
  const info = getDatabaseKindInfo(database.kind)
  const valid = !!database.name.trim() && !!database.database.trim() && (!info.supportsHost || !!database.host.trim()) && Number.isInteger(database.port) && database.port >= (info.supportsHost ? 1 : 0) && database.port <= 65535 && (!database.useSsh || (info.supportsSsh && project.servers.some((server) => server.id === database.sshServerId)))

  async function test(): Promise<void> {
    setTesting(true)
    try {
      const server = database.useSsh ? project.servers.find((s) => s.id === database.sshServerId) : undefined
      const result = await window.api.db.test(database, server)
      setTestResult(result.ok ? 'Connection succeeded.' : result.error)
    } catch (error) { setTestResult((error as Error).message) }
    finally { setTesting(false) }
  }

  return <div className="rounded-xl border border-accent/50 bg-bg-panel p-4">
    <h3 className="font-semibold">Add this database to {project.name}?</h3>
    <p className="mt-1 text-xs leading-5 text-ink-soft">Review the connection Codex found. It will be saved only when you select “Add database”.</p>
    <p className="mb-4 mt-2 select-text break-words text-[11px] text-ink-faint">Source: {approval.source}</p>
    <fieldset disabled={busy || testing} className="grid grid-cols-2 gap-3 disabled:opacity-60">
      <Field label="Display name"><Input value={database.name} onChange={(e) => patch({ name: e.target.value })} /></Field>
      <Field label="Database type"><select className="field-input" value={database.kind} onChange={(e) => patch({ kind: e.target.value as DatabaseKind })}>{DATABASE_KIND_LIST.map((info) => <option value={info.kind} key={info.kind}>{info.name}</option>)}</select></Field>
      <Field label={database.useSsh ? 'Host from SSH server' : 'Host'}><Input value={database.host} onChange={(e) => patch({ host: e.target.value })} /></Field>
      <Field label="Port"><Input type="number" min={1} max={65535} value={database.port} onChange={(e) => patch({ port: Number(e.target.value) })} /></Field>
      <Field label="Database name"><Input value={database.database} onChange={(e) => patch({ database: e.target.value })} /></Field>
      <Field label="Username"><Input value={database.username} onChange={(e) => patch({ username: e.target.value })} /></Field>
      <div className="col-span-2"><Field label="Password"><PasswordInput value={database.password} onChange={(e) => patch({ password: e.target.value })} /></Field></div>
      <label className="col-span-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={database.useSsh} onChange={(e) => patch({ useSsh: e.target.checked, sshServerId: database.sshServerId ?? project.servers[0]?.id })} /> Connect through an SSH tunnel</label>
      {database.useSsh && <div className="col-span-2"><Field label="SSH server"><select className="field-input" value={database.sshServerId ?? ''} onChange={(e) => patch({ sshServerId: e.target.value })}><option value="">Select a server</option>{project.servers.map((server) => <option value={server.id} key={server.id}>{server.name}</option>)}</select></Field></div>}
    </fieldset>
    <p className="mt-3 text-[11px] text-ink-faint">The new connection starts with database editing locked.</p>
    {testResult && <p role="status" className="mt-3 select-text break-words text-xs text-ink-soft">{testResult}</p>}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" disabled={busy || testing || !valid || !info.supported} onClick={() => void test()}>{testing ? 'Testing…' : 'Test connection'}</Button>
      <Button size="sm" variant="ghost" className="ml-auto" disabled={busy || testing} onClick={() => onDecision(null)}>Don’t add</Button>
      <Button size="sm" disabled={busy || testing || !valid} onClick={() => onDecision(database)}>{busy ? 'Saving…' : 'Add database'}</Button>
    </div>
  </div>
}
