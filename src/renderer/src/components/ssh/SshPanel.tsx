import { useEffect, useState, type ReactNode } from 'react'
import {
  Plus,
  Play,
  Pencil,
  Trash2,
  X,
  Zap,
  Terminal as TerminalIcon,
  Copy,
  MoreHorizontal
} from 'lucide-react'
import type { Project, Server } from '@shared/types'
import { useApp, useOpenRequest, EMPTY_LIVE } from '../../store'
import { cn, EmptyState, StatusDot, colorTint, AnchorMenu } from '../../lib/ui'
import { ResizeHandle, usePersistedSize } from '../../lib/resize'
import ServerDialog from '../dialogs/ServerDialog'
import SnippetsDialog from './SnippetsDialog'
import TerminalView from './TerminalView'

interface Tab {
  tabId: string
  server: Server
}

const LIVE = '#46c08a'

export default function SshPanel({
  project,
  visible = true
}: {
  project: Project
  visible?: boolean
}): ReactNode {
  const deleteServer = useApp((s) => s.deleteServer)
  const liveKeys = useApp((s) => s.liveSsh[project.id] ?? EMPTY_LIVE)
  const [dialog, setDialog] = useState<{ server?: Server; duplicateFrom?: Server } | null>(null)
  const [snippetsFor, setSnippetsFor] = useState<string | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<{
    top: number
    bottom: number
    left: number
    right: number
  } | null>(null)
  const [railW, setRailW] = usePersistedSize('ssh.rail', 224, 160, 420)

  const openSession = (server: Server): void => {
    const tabId = crypto.randomUUID()
    setTabs((t) => [...t, { tabId, server }])
    setActive(tabId)
  }

  const closeTab = (tabId: string): void => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.tabId !== tabId)
      setActive((a) => (a === tabId ? next[next.length - 1]?.tabId ?? null : a))
      return next
    })
  }

  // Command palette: focus an existing session for the server, else open one.
  useOpenRequest(project.id, 'ssh', ({ kind, id }) => {
    if (kind !== 'server' || !id) return
    const server = project.servers.find((s) => s.id === id)
    if (!server) return
    const existing = tabs.find((t) => t.server.id === id)
    if (existing) setActive(existing.tabId)
    else openSession(server)
  })

  const serverLive = (serverId: string): boolean =>
    tabs.some((t) => t.server.id === serverId && liveKeys.includes(t.tabId))

  const snippetsServer = project.servers.find((s) => s.id === snippetsFor) ?? null

  return (
    <div className="flex h-full">
      {/* Server rail */}
      <div
        style={{ width: railW }}
        className="flex shrink-0 flex-col border-r border-line bg-bg-panel"
      >
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Servers</span>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-soft hover:bg-bg-hover hover:text-ink"
            title="Add server"
            onClick={() => setDialog({})}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {project.servers.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-ink-faint">
              No servers. Add one to connect.
            </p>
          )}
          {project.servers.map((s) => {
            const bg = colorTint(s.color)
            const hoverBg = colorTint(s.color, 0.22) ?? undefined
            return (
              <div
                key={s.id}
                className={cn(
                  'group relative mb-1 rounded-lg px-2.5 py-2 transition-colors',
                  !s.color && 'hover:bg-bg-hover'
                )}
                style={
                  s.color
                    ? {
                        backgroundColor: bg,
                        borderLeft: `3px solid ${s.color}`,
                        paddingLeft: 7
                      }
                    : undefined
                }
                onMouseEnter={(e) => {
                  if (hoverBg) e.currentTarget.style.backgroundColor = hoverBg
                }}
                onMouseLeave={(e) => {
                  if (bg) e.currentTarget.style.backgroundColor = bg
                }}
              >
                <button className="block w-full min-w-0 pr-7 text-left" onDoubleClick={() => openSession(s)}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold">{s.name}</span>
                    {serverLive(s.id) && <StatusDot color={LIVE} />}
                  </div>
                  <div className="truncate text-[11px] text-ink-faint">
                    {s.username}@{s.host}:{s.port}
                  </div>
                </button>
                <button
                  title="Actions"
                  className={cn(
                    'absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint transition-opacity hover:bg-black/10 hover:text-ink',
                    menuId === s.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (menuId === s.id) {
                      setMenuId(null)
                      setMenuAnchor(null)
                      return
                    }
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenuId(s.id)
                    setMenuAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })
                  }}
                >
                  <MoreHorizontal size={15} />
                </button>
                {menuId === s.id && menuAnchor && (
                  <ServerMenu
                    anchor={menuAnchor}
                    onClose={() => {
                      setMenuId(null)
                      setMenuAnchor(null)
                    }}
                    onConnect={() => openSession(s)}
                    onSnippets={() => setSnippetsFor(s.id)}
                    onEdit={() => setDialog({ server: s })}
                    onDuplicate={() => setDialog({ duplicateFrom: s })}
                    onDelete={() => {
                      if (confirm(`Delete server "${s.name}"?`)) deleteServer(project.id, s.id)
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
      <ResizeHandle axis="x" size={railW} onResize={setRailW} />

      {/* Terminal tabs */}
      <div className="flex min-w-0 flex-1 flex-col bg-bg-base">
        {tabs.length === 0 ? (
          <EmptyState
            icon={<TerminalIcon size={42} />}
            title="No active sessions"
            subtitle="Double-click a server to open a terminal."
          />
        ) : (
          <>
            <div className="flex items-stretch border-b border-line bg-bg-panel">
              <div className="flex min-w-0 flex-1 overflow-x-auto">
                {tabs.map((t) => (
                  <button
                    key={t.tabId}
                    onClick={() => setActive(t.tabId)}
                    className={cn(
                      'group flex shrink-0 items-center gap-2 border-r border-t-2 border-line px-3.5 py-2 text-[13px]',
                      active === t.tabId
                        ? 'border-t-accent bg-bg-base text-ink'
                        : 'border-t-transparent text-ink-soft hover:bg-bg-hover'
                    )}
                  >
                    <TerminalIcon
                      size={13}
                      style={t.server.color ? { color: t.server.color } : undefined}
                    />
                    <span
                      className="max-w-[140px] truncate rounded px-1.5 py-0.5"
                      style={
                        t.server.color
                          ? {
                              backgroundColor: colorTint(
                                t.server.color,
                                active === t.tabId ? 0.22 : 0.14
                              )
                            }
                          : undefined
                      }
                    >
                      {t.server.name}
                    </span>
                    {liveKeys.includes(t.tabId) && <StatusDot color={LIVE} />}
                    <span
                      className="rounded p-0.5 opacity-0 hover:bg-bg-hover hover:text-bad group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(t.tabId)
                      }}
                    >
                      <X size={12} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              {tabs.map((t) => (
                <div key={t.tabId} className={cn('absolute inset-0', active === t.tabId ? 'block' : 'hidden')}>
                  <TerminalView
                    server={t.server}
                    projectId={project.id}
                    liveKey={t.tabId}
                    active={visible && active === t.tabId}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {dialog && (
        <ServerDialog
          projectId={project.id}
          server={dialog.server}
          duplicateFrom={dialog.duplicateFrom}
          onClose={() => setDialog(null)}
        />
      )}
      {snippetsServer && (
        <SnippetsDialog
          projectId={project.id}
          server={snippetsServer}
          onClose={() => setSnippetsFor(null)}
        />
      )}
    </div>
  )
}

function ServerMenu({
  anchor,
  onClose,
  onConnect,
  onSnippets,
  onEdit,
  onDuplicate,
  onDelete
}: {
  anchor: { top: number; bottom: number; left: number; right: number }
  onClose: () => void
  onConnect: () => void
  onSnippets: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <AnchorMenu anchor={anchor} onClose={onClose}>
      <MenuItem
        icon={<Play size={13} />}
        label="Connect"
        onClick={() => {
          onConnect()
          onClose()
        }}
      />
      <MenuItem
        icon={<Zap size={13} />}
        label="Snippets"
        onClick={() => {
          onSnippets()
          onClose()
        }}
      />
      <MenuItem
        icon={<Pencil size={13} />}
        label="Edit"
        onClick={() => {
          onEdit()
          onClose()
        }}
      />
      <MenuItem
        icon={<Copy size={13} />}
        label="Duplicate"
        onClick={() => {
          onDuplicate()
          onClose()
        }}
      />
      <MenuItem
        icon={<Trash2 size={13} />}
        label="Delete"
        danger
        onClick={() => {
          onDelete()
          onClose()
        }}
      />
    </AnchorMenu>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}): ReactNode {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover',
        danger ? 'text-bad' : 'text-ink'
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}
