import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Activity,
  Boxes,
  Cog,
  FolderTree,
  Plug,
  RotateCw,
  ServerCog,
  Shield,
  Unplug,
  X
} from 'lucide-react'
import type { Project, RemoteHostInfo, Server } from '@shared/types'
import { useApp, useOpenRequest } from '../../store'
import { cn, EmptyState, StatusDot, colorTint } from '../../lib/ui'
import { ResizeHandle, usePersistedSize } from '../../lib/resize'
import { ToolButton } from './common'
import FilesPanel from './FilesPanel'
import MonitorPanel from './MonitorPanel'
import SecurityPanel from './SecurityPanel'
import ServicesPanel from './ServicesPanel'
import DockerPanel from './DockerPanel'

type SubTab = 'files' | 'monitor' | 'security' | 'services' | 'docker'

const SUB_TABS: { id: SubTab; label: string; icon: ReactNode }[] = [
  { id: 'files', label: 'Files', icon: <FolderTree size={14} /> },
  { id: 'monitor', label: 'Monitor', icon: <Activity size={14} /> },
  { id: 'security', label: 'Security', icon: <Shield size={14} /> },
  { id: 'services', label: 'Services', icon: <Cog size={14} /> },
  { id: 'docker', label: 'Docker', icon: <Boxes size={14} /> }
]

type Status = 'idle' | 'connecting' | 'connected' | 'error'
interface Conn {
  status: Status
  info?: RemoteHostInfo
  error?: string
}

const STATUS_COLOR: Record<Status, string> = {
  idle: '#646b78',
  connecting: '#e0b341',
  connected: '#46c08a',
  error: '#e0625e'
}

export default function OpsPanel({
  project,
  visible = true
}: {
  project: Project
  visible?: boolean
}): ReactNode {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [opened, setOpened] = useState<string[]>([])
  const [conns, setConns] = useState<Record<string, Conn>>({})
  const [tabs, setTabs] = useState<Record<string, SubTab>>({})
  const [railW, setRailW] = usePersistedSize('ops.rail', 216, 160, 420)
  const setLive = useApp((s) => s.setLive)

  const selected = project.servers.find((s) => s.id === selectedId) ?? null
  const conn = selectedId ? conns[selectedId] : undefined
  const subTab: SubTab = (selectedId && tabs[selectedId]) || 'files'

  // Keep workspace / sidebar green dots in sync with connected remote sessions.
  useEffect(() => {
    const tracked = useApp.getState().liveOps[project.id] ?? []
    for (const key of tracked) {
      if (!opened.includes(key) || conns[key]?.status !== 'connected') {
        setLive('ops', project.id, key, false)
      }
    }
    for (const id of opened) {
      setLive('ops', project.id, id, conns[id]?.status === 'connected')
    }
  }, [opened, conns, project.id, setLive])

  useEffect(() => {
    return () => {
      const keys = useApp.getState().liveOps[project.id] ?? []
      for (const key of keys) {
        useApp.getState().setLive('ops', project.id, key, false)
      }
    }
  }, [project.id])

  const connect = useCallback((server: Server) => {
    setConns((c) => ({ ...c, [server.id]: { status: 'connecting' } }))
    void window.api.ops.connect(server).then((res) => {
      setConns((c) => ({
        ...c,
        [server.id]: res.ok
          ? { status: 'connected', info: res.data }
          : { status: 'error', error: res.error }
      }))
    })
  }, [])

  // The main process drops pooled sessions when the socket dies — reflect that.
  useEffect(
    () =>
      window.api.ops.onClosed(({ serverId }) => {
        setConns((c) =>
          c[serverId]?.status === 'connected' ? { ...c, [serverId]: { status: 'idle' } } : c
        )
      }),
    []
  )

  // Drop panels (and their pooled connection) for servers deleted from the project.
  useEffect(() => {
    const ids = new Set(project.servers.map((s) => s.id))
    const gone = opened.filter((id) => !ids.has(id))
    if (gone.length) {
      for (const id of gone) void window.api.ops.disconnect(id)
      setOpened((prev) => {
        const next = prev.filter((id) => ids.has(id))
        setSelectedId((cur) => (cur && !ids.has(cur) ? (next[next.length - 1] ?? null) : cur))
        return next
      })
      setTabs((t) => {
        const next = { ...t }
        for (const id of gone) delete next[id]
        return next
      })
      setConns((c) => {
        const next = { ...c }
        for (const id of gone) delete next[id]
        return next
      })
    }
  }, [project.servers, opened])

  const select = (server: Server): void => {
    setSelectedId(server.id)
    setOpened((o) => (o.includes(server.id) ? o : [...o, server.id]))
    const state = conns[server.id]?.status
    if (state !== 'connected' && state !== 'connecting') connect(server)
  }

  const disconnect = (server: Server): void => {
    void window.api.ops.disconnect(server.id)
    setConns((c) => ({ ...c, [server.id]: { status: 'idle' } }))
  }

  const closeSession = (serverId: string): void => {
    void window.api.ops.disconnect(serverId)
    setConns((c) => ({ ...c, [serverId]: { status: 'idle' } }))
    setOpened((prev) => {
      const next = prev.filter((id) => id !== serverId)
      setSelectedId((cur) => (cur === serverId ? (next[next.length - 1] ?? null) : cur))
      return next
    })
    setTabs((t) => {
      const { [serverId]: _, ...rest } = t
      return rest
    })
  }

  // Command palette: select (and connect) the requested server.
  useOpenRequest(project.id, 'ops', ({ kind, id }) => {
    if (kind !== 'server' || !id) return
    const server = project.servers.find((s) => s.id === id)
    if (server) select(server)
  })

  if (project.servers.length === 0) {
    return (
      <EmptyState
        icon={<ServerCog size={42} />}
        title="No servers yet"
        subtitle="Add an SSH server in the SSH tab, then manage its files, health, and firewall from here."
      />
    )
  }

  return (
    <div className="flex h-full">
      {/* Server rail */}
      <div style={{ width: railW }} className="flex shrink-0 flex-col border-r border-line bg-bg-panel">
        <div className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
          Servers
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {project.servers.map((s) => {
            const state = conns[s.id]?.status ?? 'idle'
            const active = s.id === selectedId
            const tint = colorTint(s.color)
            return (
              <button
                key={s.id}
                onClick={() => {
                  if (opened.includes(s.id)) setSelectedId(s.id)
                }}
                onDoubleClick={() => select(s)}
                className={cn(
                  'mb-1 block w-full rounded-lg px-2.5 py-2 text-left transition-colors',
                  active ? 'bg-accent-dim' : 'hover:bg-bg-hover'
                )}
                style={
                  !active && tint
                    ? { backgroundColor: tint, borderLeft: `3px solid ${s.color}`, paddingLeft: 7 }
                    : undefined
                }
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold">{s.name}</span>
                  {state !== 'idle' && <StatusDot color={STATUS_COLOR[state]} />}
                </div>
                <div className="truncate text-[11px] text-ink-faint">
                  {s.username}@{s.host}
                </div>
              </button>
            )
          })}
        </div>
      </div>
      <ResizeHandle axis="x" size={railW} onResize={setRailW} />

      <div className="flex min-w-0 flex-1 flex-col bg-bg-base">
        {opened.length === 0 || !selected ? (
          <EmptyState
            icon={<ServerCog size={42} />}
            title="Pick a server"
            subtitle="Double-click a server on the left to browse its files, watch its load, and manage its firewall."
          />
        ) : (
          <>
            <div className="flex items-stretch border-b border-line bg-bg-panel">
              <div className="flex min-w-0 flex-1 overflow-x-auto">
                {opened.map((id) => {
                  const server = project.servers.find((s) => s.id === id)
                  if (!server) return null
                  const state = conns[id]?.status ?? 'idle'
                  const isActive = id === selectedId
                  return (
                    <button
                      key={id}
                      onClick={() => setSelectedId(id)}
                      className={cn(
                        'group flex shrink-0 items-center gap-2 border-r border-t-2 border-line px-3.5 py-2 text-[13px]',
                        isActive
                          ? 'border-t-accent bg-bg-base text-ink'
                          : 'border-t-transparent text-ink-soft hover:bg-bg-hover'
                      )}
                    >
                      <ServerCog
                        size={13}
                        style={server.color ? { color: server.color } : undefined}
                      />
                      <span
                        className="max-w-[140px] truncate rounded px-1.5 py-0.5"
                        style={
                          server.color
                            ? {
                                backgroundColor: colorTint(
                                  server.color,
                                  isActive ? 0.22 : 0.14
                                )
                              }
                            : undefined
                        }
                      >
                        {server.name}
                      </span>
                      {state !== 'idle' && <StatusDot color={STATUS_COLOR[state]} />}
                      <span
                        className="rounded p-0.5 opacity-0 hover:bg-bg-hover hover:text-bad group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation()
                          closeSession(id)
                        }}
                      >
                        <X size={12} />
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 border-b border-line bg-bg-panel px-3 py-1.5">
              <StatusDot color={STATUS_COLOR[conn?.status ?? 'idle']} />
              <span className="truncate text-xs text-ink-soft">
                {conn?.status === 'connected' && conn.info
                  ? `${conn.info.user}@${conn.info.hostname}`
                  : conn?.status === 'connecting'
                    ? `Connecting to ${selected.host}…`
                    : conn?.status === 'error'
                      ? `Error: ${conn.error}`
                      : 'Disconnected'}
              </span>
              {conn?.status === 'connected' && conn.info && (
                <>
                  {conn.info.os && (
                    <span className="truncate text-[11px] text-ink-faint">{conn.info.os}</span>
                  )}
                  <span className="text-[11px] text-ink-faint">
                    {conn.info.isRoot ? 'root' : conn.info.canSudo ? 'sudo available' : 'no sudo'}
                  </span>
                </>
              )}
              <div className="ml-auto flex items-center gap-1">
                {conn?.status === 'connected' ? (
                  <ToolButton icon={<Unplug size={13} />} onClick={() => disconnect(selected)}>
                    Disconnect
                  </ToolButton>
                ) : (
                  <ToolButton
                    icon={conn?.status === 'connecting' ? <RotateCw size={13} /> : <Plug size={13} />}
                    disabled={conn?.status === 'connecting'}
                    onClick={() => connect(selected)}
                  >
                    {conn?.status === 'connecting' ? 'Connecting…' : 'Connect'}
                  </ToolButton>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1 border-b border-line bg-bg-panel px-2">
              {SUB_TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTabs((s) => ({ ...s, [selected.id]: t.id }))}
                  className={cn(
                    'flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12px] font-semibold transition-colors',
                    subTab === t.id
                      ? 'border-accent text-ink'
                      : 'border-transparent text-ink-soft hover:text-ink'
                  )}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>

            <div className="relative min-h-0 flex-1">
              {opened.map((id) => {
                const server = project.servers.find((s) => s.id === id)
                if (!server) return null
                const shown = id === selectedId
                const state = conns[id]
                const tab = tabs[id] ?? 'files'
                const live = visible && shown && state?.status === 'connected'
                return (
                  <div key={id} className={cn('absolute inset-0', shown ? 'block' : 'hidden')}>
                    {state?.status === 'connected' ? (
                      <>
                        <Pane show={tab === 'files'}>
                          <FilesPanel server={server} info={state.info} active={live && tab === 'files'} />
                        </Pane>
                        <Pane show={tab === 'monitor'}>
                          <MonitorPanel server={server} active={live && tab === 'monitor'} />
                        </Pane>
                        <Pane show={tab === 'security'}>
                          <SecurityPanel server={server} info={state.info} active={live && tab === 'security'} />
                        </Pane>
                        <Pane show={tab === 'services'}>
                          <ServicesPanel server={server} active={live && tab === 'services'} />
                        </Pane>
                        <Pane show={tab === 'docker'}>
                          <DockerPanel server={server} active={live && tab === 'docker'} />
                        </Pane>
                      </>
                    ) : (
                      <EmptyState
                        icon={<Plug size={38} />}
                        title={
                          state?.status === 'connecting' ? 'Connecting…' : 'Not connected'
                        }
                        subtitle={state?.error ?? 'Connect to this server to manage it.'}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Keeps every sub-panel mounted so listings and history survive tab switches. */
function Pane({ show, children }: { show: boolean; children: ReactNode }): ReactNode {
  return <div className={cn('absolute inset-0', show ? 'block' : 'hidden')}>{children}</div>
}
