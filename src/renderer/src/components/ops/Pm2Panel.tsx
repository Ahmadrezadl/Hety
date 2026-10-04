import { useCallback, useState, type ReactNode } from 'react'
import { FileText, Play, RotateCw, Save, Square, Trash2, Workflow } from 'lucide-react'
import type { Pm2Action, Pm2Instance, Pm2Process, Pm2Report, Pm2Scope, Server } from '@shared/types'
import { cn, EmptyState, Modal } from '../../lib/ui'
import { toast } from '../../lib/toast'
import {
  Badge, Card, FilterInput, formatBytes, formatUptime, Loading, PanelError,
  Td, Th, ToolButton, useLoader, usePoll
} from './common'

interface LogTarget { scope: Pm2Scope; user: string; process: Pm2Process }

export default function Pm2Panel({ server, active }: { server: Server; active: boolean }): ReactNode {
  const load = useCallback(() => window.api.ops.pm2(server), [server])
  const { data, error, loading, refresh } = useLoader<Pm2Report>(load, active)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState('')
  const [logsFor, setLogsFor] = useState<LogTarget | null>(null)
  usePoll(refresh, 10000, active && Boolean(data?.installed) && !loading && !busy)

  const act = async (instance: Pm2Instance, process: Pm2Process, action: Pm2Action): Promise<void> => {
    if ((action === 'stop' || action === 'delete') &&
      !confirm(`${action === 'stop' ? 'Stop' : 'Remove'} "${process.name}" (PM2 #${process.id}) as ${instance.user} on ${server.name}?`)) return
    setBusy(`${instance.scope}:${process.id}:${action}`)
    try {
      const res = await window.api.ops.pm2Action(server, instance.scope, action, process.id)
      if (!res.ok) toast.error(`${action} ${process.name}: ${res.error}`)
      else { toast.success(`${process.name}: ${action} completed`); refresh() }
    } catch (e) {
      toast.error((e as Error).message)
    } finally { setBusy('') }
  }

  const save = async (instance: Pm2Instance): Promise<void> => {
    setBusy(`${instance.scope}:save`)
    try {
      const res = await window.api.ops.pm2Save(server, instance.scope)
      if (!res.ok) toast.error(`Save ${instance.user} process list: ${res.error}`)
      else toast.success(`${instance.user} PM2 process list saved`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally { setBusy('') }
  }

  if (!data && loading) return <Loading label="Reading user and root PM2 processes…" />
  if (!data) return <PanelError message={error || 'No data'} onRetry={refresh} />

  const needle = filter.trim().toLowerCase()
  const count = data.instances.reduce((n, i) => n + i.processes.length, 0)
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-bg-panel px-3 py-1.5">
        <Workflow size={13} className="text-ink-faint" />
        <span className="text-[12px] font-semibold">PM2</span>
        <span className="text-[11px] text-ink-faint">{count} processes</span>
        <div className="ml-auto flex items-center gap-1">
          <FilterInput value={filter} onChange={setFilter} placeholder="Filter processes…" className="w-44" />
          <ToolButton icon={<RotateCw size={13} className={cn(loading && 'animate-spin')} />}
            title="Refresh" disabled={loading || Boolean(busy)} onClick={refresh} />
        </div>
      </div>
      {error && <PanelError message={error} onRetry={refresh} />}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {data.sameList && <p className="mb-3 text-[11px] text-ink-faint">User and root returned the same process list. Showing it once.</p>}
        {!data.installed && !data.instances.some((i) => i.message) && (
          <EmptyState icon={<Workflow size={40} />} title="PM2 is not installed"
            subtitle="Install PM2 on this server, then refresh to manage its processes here." />
        )}
        {data.instances.map((instance) => {
          const processes = instance.processes.filter((p) => !needle ||
            `${p.name} ${p.id} ${p.namespace} ${p.status} ${p.script}`.toLowerCase().includes(needle))
          return (data.installed || instance.message) && (
            <section key={instance.scope} className="mb-3 overflow-hidden rounded-xl border border-line bg-bg-panel">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <span className="text-[12px] font-semibold">{instance.scope === 'root' ? 'Root' : 'User'} · {instance.user}</span>
                <span className="truncate text-[11px] text-ink-faint" title={instance.binary}>{instance.home}</span>
                <span className="ml-auto text-[11px] text-ink-faint">{instance.processes.length} processes</span>
                {instance.accessible && <ToolButton icon={<Save size={12} />} title="Save this account’s process list for PM2 resurrect"
                  disabled={Boolean(busy)} onClick={() => void save(instance)}>Save list</ToolButton>}
              </div>
              {instance.message ? <PanelError message={instance.message} onRetry={refresh} /> :
                !instance.installed ? <p className="p-4 text-[12px] text-ink-faint">PM2 is not installed for this account.</p> : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead><tr>
                        <Th>ID</Th><Th>Name</Th><Th>Status</Th><Th>Mode</Th><Th>PID</Th>
                        <Th align="right">CPU</Th><Th align="right">Memory</Th><Th>Uptime</Th>
                        <Th align="right">Restarts</Th><Th align="right">Actions</Th>
                      </tr></thead>
                      <tbody>{processes.map((p) => (
                        <tr key={p.id} className="border-b border-line/40 hover:bg-bg-hover">
                          <Td className="font-mono text-ink-faint">{p.id}</Td>
                          <Td title={`${p.script}\nWorking directory: ${p.cwd}`}>
                            <div className="font-semibold">{p.name}</div>
                            <div className="text-[10px] text-ink-faint">{p.namespace}</div>
                          </Td>
                          <Td><Badge tone={p.status === 'online' ? 'ok' : p.status === 'errored' ? 'bad' : 'neutral'}>{p.status}</Badge></Td>
                          <Td className="text-ink-soft">{p.mode || '—'}</Td>
                          <Td className="font-mono text-ink-faint">{p.pid || '—'}</Td>
                          <Td align="right">{p.cpu.toFixed(1)}%</Td>
                          <Td align="right">{formatBytes(p.memory)}</Td>
                          <Td>{p.status === 'online' && p.uptime ? formatUptime(Math.max(0, (Date.now() - p.uptime) / 1000)) : '—'}</Td>
                          <Td align="right">{p.restarts}</Td>
                          <Td align="right"><span className="flex justify-end gap-0.5">
                            <ToolButton icon={p.status === 'online' ? <RotateCw size={12} /> : <Play size={12} />}
                              title={p.status === 'online' ? 'Restart' : 'Start'} disabled={Boolean(busy)}
                              onClick={() => void act(instance, p, 'restart')} />
                            {p.status === 'online' && <>
                              <ToolButton title="Reload" disabled={Boolean(busy)} onClick={() => void act(instance, p, 'reload')}>Reload</ToolButton>
                              <ToolButton icon={<Square size={12} />} title="Stop" danger disabled={Boolean(busy)} onClick={() => void act(instance, p, 'stop')} />
                            </>}
                            <ToolButton icon={<FileText size={12} />} title="Logs" onClick={() => setLogsFor({ scope: instance.scope, user: instance.user, process: p })} />
                            <ToolButton icon={<Trash2 size={12} />} title="Remove from PM2" danger disabled={Boolean(busy)} onClick={() => void act(instance, p, 'delete')} />
                          </span></Td>
                        </tr>
                      ))}</tbody>
                    </table>
                    {processes.length === 0 && <p className="p-4 text-[12px] text-ink-faint">{needle ? 'No matching processes.' : 'No PM2 processes for this account.'}</p>}
                  </div>
                )}
            </section>
          )
        })}
      </div>
      {logsFor && <Pm2Logs key={`${logsFor.scope}:${logsFor.process.id}`} server={server} target={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  )
}

function Pm2Logs({ server, target, onClose }: { server: Server; target: LogTarget; onClose: () => void }): ReactNode {
  const load = useCallback(() => window.api.ops.pm2Logs(server, target.scope, target.process.id, 300),
    [server, target.scope, target.process.id])
  const { data, error, loading, refresh } = useLoader<string>(load)
  return (
    <Modal title={`${target.process.name} · ${target.user} · PM2 #${target.process.id}`} onClose={onClose} width={900}>
      <div className="flex h-[62vh] flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-faint">Last 300 log lines</span>
          <ToolButton className="ml-auto" icon={<RotateCw size={13} className={cn(loading && 'animate-spin')} />} disabled={loading} onClick={refresh}>Refresh</ToolButton>
        </div>
        {error ? <PanelError message={error} onRetry={refresh} /> : data === null ? <Loading /> : (
          <Card className="min-h-0 flex-1 overflow-auto">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-soft">{data || 'No output.'}</pre>
          </Card>
        )}
      </div>
    </Modal>
  )
}
