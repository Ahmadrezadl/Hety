import { useEffect, useState, type ReactNode } from 'react'
import { Database, Server, GitBranch, Columns3, ShieldCheck, AlertTriangle, ChevronDown, Globe, FolderOpen } from 'lucide-react'
import type { Project } from '@shared/types'
import { ACCESS_MODES, ACCESS_LABELS, ACCESS_DESCRIPTIONS, type AccessMode, type CodexAccess, type ResourceSection } from '@shared/codexAccess'
import { Button, Modal, cn } from '../../lib/ui'

interface Entry { id: string; name: string; detail: string }
interface Props { project: Project; access: CodexAccess; disabled: boolean; customFolder: boolean; onChange: (access: CodexAccess) => void }
const tone = (mode: AccessMode): string => mode === 'full' ? 'text-bad' : mode === 'approval' ? 'text-accent-hover' : mode === 'read' ? 'text-ink-soft' : 'text-ink-faint'

export default function ContextAccessSettings({ project, access, disabled, customFolder, onChange }: Props): ReactNode {
  const [warning, setWarning] = useState<{ targets: string[]; apply: () => void } | null>(null)
  const [search, setSearch] = useState<Record<ResourceSection, string>>({databases:'',servers:'',repositories:'',planning:''})
  useEffect(() => {
    if (!warning) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setWarning(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [warning])
  const apply = (next: CodexAccess, targets: string[]): void => {
    if (disabled) return
    if (targets.length) setWarning({ targets, apply: () => onChange(next) })
    else onChange(next)
  }
  const change = (section: ResourceSection, entries: Entry[], ids: string[], mode: AccessMode): void => {
    const next = { ...access, [section]: { ...access[section], ...Object.fromEntries(ids.map((id) => [id, mode])) } }
    apply(next, mode === 'full' ? entries.filter((entry) => ids.includes(entry.id) && access[section][entry.id] !== 'full').map((entry) => entry.name) : [])
  }
  const section = (key: ResourceSection, title: string, icon: ReactNode, entries: Entry[], contextOnly = false): ReactNode => {
    const selected = entries.filter((entry) => access[key][entry.id] !== 'excluded')
    const full = selected.filter((entry) => access[key][entry.id] === 'full').length
    const matches = entries.filter((entry) => `${entry.name} ${entry.detail}`.toLowerCase().includes(search[key].toLowerCase()))
    return <details key={key} open={key === 'databases' || key === 'servers'} className="group rounded-xl border border-line bg-bg-elevated">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-xs font-semibold [&::-webkit-details-marker]:hidden">
        {icon}<span>{title}</span><span className="ml-auto text-[10px] font-normal text-ink-faint">{selected.length} / {entries.length} included</span><ChevronDown size={13} className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-line px-3 pb-3 pt-2">
        {!entries.length ? <p className="py-2 text-[11px] text-ink-faint">No {title.toLowerCase()} saved in this project.</p> : <>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" disabled={disabled || selected.length === entries.length} className="text-[10px] text-accent-hover disabled:opacity-40" onClick={() => apply({ ...access, [key]: { ...access[key], ...Object.fromEntries(entries.map((entry) => [entry.id, access[key][entry.id] === 'excluded' ? 'read' : access[key][entry.id]])) } }, [])}>Select all</button>
            <button type="button" disabled={disabled || !selected.length} className="text-[10px] text-ink-soft disabled:opacity-40" onClick={() => change(key, entries, entries.map((entry) => entry.id), 'excluded')}>Deselect all</button>
            {!contextOnly && <select aria-label={`Set access for included ${title.toLowerCase()}`} value="" disabled={disabled || !selected.length} className="ml-auto max-w-full rounded-md border border-line bg-bg-input px-1.5 py-1 text-[10px] text-ink-soft" onChange={(event) => change(key, entries, selected.map((entry) => entry.id), event.target.value as AccessMode)}>
              <option value="" disabled>Set included to…</option>{ACCESS_MODES.map((mode) => <option key={mode} value={mode}>{ACCESS_LABELS[mode]}</option>)}
            </select>}
          </div>
          {contextOnly && <p className="mb-2 text-[10px] text-ink-faint">Planning provides context only; editing tools aren’t available.</p>}
          {entries.length > 5 && <input aria-label={`Find ${title.toLowerCase()}`} placeholder={`Find ${title.toLowerCase()}…`} value={search[key]} onChange={(event) => setSearch((current) => ({...current,[key]:event.target.value}))} className="field-input mb-3 text-xs" />}
          {!matches.length && <p className="py-2 text-[11px] text-ink-faint">No matching resources.</p>}
          <div className="space-y-2">{matches.map((entry) => {
            const mode = access[key][entry.id] ?? 'read'
            return <div key={entry.id} className={cn('rounded-lg border p-2.5', mode === 'full' ? 'border-bad/40 bg-bad/5' : 'border-line bg-bg-panel', mode === 'excluded' && 'opacity-65')}>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" className="mt-0.5 accent-accent" aria-label={`Include ${entry.name} in Codex context`} checked={mode !== 'excluded'} disabled={disabled} onChange={(event) => change(key, entries, [entry.id], event.target.checked ? 'read' : 'excluded')} />
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium" title={entry.name}>{entry.name}</span><span className="mt-1 block break-all text-[10px] leading-4 text-ink-faint">{entry.detail}</span></span>
              </label>
              {!contextOnly && <div className="mt-2 pl-6"><AccessSelect label={`Access for ${entry.name}`} mode={mode} disabled={disabled} onChange={(value) => change(key, entries, [entry.id], value)} /></div>}
            </div>
          })}</div>
          {full > 0 && <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-4 text-bad"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{full} {full === 1 ? 'resource allows' : 'resources allow'} changes without asking.</p>}
        </>}
      </div>
    </details>
  }
  return <div className="space-y-3">
    <div><h3 className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck size={14} className="text-accent-hover" />Context & access</h3><p className="mt-2 text-[11px] leading-5 text-ink-faint">Choose what Codex can see and change. Settings apply to the next message and are saved for this project.</p></div>
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-line p-2.5">{ACCESS_MODES.map((mode) => <div key={mode}><div className={cn('text-[10px] font-semibold', tone(mode))}>{ACCESS_LABELS[mode]}</div><div className="mt-0.5 text-[9px] leading-4 text-ink-faint">{mode === 'excluded' ? 'Hidden and blocked' : mode === 'read' ? 'Inspect, no changes' : mode === 'approval' ? 'Ask before every write' : 'Writes without asking'}</div></div>)}</div>
    {section('databases', 'Databases', <Database size={14} />, project.databases.map((db) => ({id:db.id,name:db.name,detail:`${db.kind} · ${db.host}:${db.port} / ${db.database}`})))}
    {section('servers', 'Servers', <Server size={14} />, project.servers.map((server) => ({id:server.id,name:server.name,detail:`${server.username}@${server.host}:${server.port}`})))}
    {section('repositories', 'Repositories', <GitBranch size={14} />, project.repositories.map((repo) => ({id:repo.id,name:repo.name,detail:repo.path})))}
    {section('planning', 'Planning', <Columns3 size={14} />, (project.board?.columns ?? []).map((column) => ({id:column.id,name:column.name,detail:`${column.cards.length} cards`})), true)}
    <div className="rounded-xl border border-line bg-bg-elevated p-3"><h4 className="mb-2 flex items-center gap-2 text-xs font-semibold"><Globe size={14} />APIs & web uploads</h4><AccessSelect label="API and web upload access" mode={access.http} disabled={disabled} onChange={(mode) => apply({...access,http:mode},mode==='full' && access.http!=='full' ? ['APIs & web uploads'] : [])} /><p className="mt-2 text-[10px] leading-4 text-ink-faint">Applies to HTTP requests and multipart uploads. SFTP uploads follow the destination server’s access.</p></div>
    {customFolder && <div className="rounded-xl border border-line bg-bg-elevated p-3"><h4 className="mb-2 flex items-center gap-2 text-xs font-semibold"><FolderOpen size={14} />Chosen folder</h4><AccessSelect label="Chosen folder access" mode={access.localFolder} disabled={disabled} onChange={(mode) => apply({...access,localFolder:mode},mode==='full' && access.localFolder!=='full' ? ['Chosen folder'] : [])} /></div>}
    {disabled && <p className="text-[10px] text-ink-faint">Stop the current run to change access.</p>}
    {warning && <Modal title="Enable full access?" onClose={() => setWarning(null)} width={470}><div role="alertdialog" aria-modal="true" aria-label="Full access warning">
      <div className="flex items-start gap-3"><AlertTriangle size={24} className="shrink-0 text-bad" /><p className="text-sm leading-6">Codex will be able to change or delete data, overwrite files, or run commands <strong>without asking you first</strong> for these resources.</p></div>
      <ul className="my-4 max-h-40 overflow-auto rounded-lg border border-bad/30 bg-bad/5 px-4 py-3 text-xs">{warning.targets.map((name,index) => <li key={index} className="py-1">{name}</li>)}</ul>
      <p className="text-xs leading-5 text-ink-soft">Server and local commands can also affect other systems reachable from that machine. Choose Approve changes if you want to review each action.</p>
      <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" autoFocus onClick={() => setWarning(null)}>Cancel</Button><Button variant="danger" disabled={disabled} onClick={() => { if (!disabled) warning.apply(); setWarning(null) }}>Enable full access</Button></div>
    </div></Modal>}
  </div>
}

function AccessSelect({ label, mode, disabled, onChange }: {label:string;mode:AccessMode;disabled:boolean;onChange:(mode:AccessMode)=>void}): ReactNode {
  return <><select aria-label={label} value={mode} disabled={disabled} className={cn('w-full rounded-md border border-line bg-bg-input px-2 py-1.5 text-[11px] outline-none focus:border-accent',tone(mode))} onChange={(event) => onChange(event.target.value as AccessMode)}>{ACCESS_MODES.map((value) => <option key={value} value={value}>{ACCESS_LABELS[value]}</option>)}</select><p className={cn('mt-1.5 text-[10px] leading-4',mode==='full' ? 'text-bad' : 'text-ink-faint')}>{ACCESS_DESCRIPTIONS[mode]}</p></>
}
