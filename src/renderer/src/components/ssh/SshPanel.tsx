import { useState, type ReactNode } from 'react'
import { Plus, Play, Pencil, Trash2, X, Terminal as TerminalIcon } from 'lucide-react'
import type { Project, Server } from '@shared/types'
import { useApp } from '../../store'
import { cn, EmptyState } from '../../lib/ui'
import ServerDialog from '../dialogs/ServerDialog'
import TerminalView from './TerminalView'

interface Tab {
  tabId: string
  server: Server
}

export default function SshPanel({ project }: { project: Project }): ReactNode {
  const deleteServer = useApp((s) => s.deleteServer)
  const [dialog, setDialog] = useState<{ server?: Server } | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)

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

  return (
    <div className="flex h-full">
      {/* Server rail */}
      <div className="flex w-56 shrink-0 flex-col border-r border-line bg-bg-panel">
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
          {project.servers.map((s) => (
            <div
              key={s.id}
              className="group mb-1 rounded-lg px-2.5 py-2 hover:bg-bg-hover"
              style={s.color ? { borderLeft: `3px solid ${s.color}`, paddingLeft: 7 } : undefined}
            >
              <div className="flex items-center gap-2">
                <button className="min-w-0 flex-1 text-left" onDoubleClick={() => openSession(s)}>
                  <div className="flex items-center gap-1.5">
                    {s.color && (
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                    )}
                    <span className="truncate text-[13px] font-semibold">{s.name}</span>
                  </div>
                  <div className="truncate text-[11px] text-ink-faint">
                    {s.username}@{s.host}:{s.port}
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                  <IconBtn title="Connect" onClick={() => openSession(s)}>
                    <Play size={13} />
                  </IconBtn>
                  <IconBtn title="Edit" onClick={() => setDialog({ server: s })}>
                    <Pencil size={13} />
                  </IconBtn>
                  <IconBtn
                    title="Delete"
                    danger
                    onClick={() => confirm(`Delete server "${s.name}"?`) && deleteServer(project.id, s.id)}
                  >
                    <Trash2 size={13} />
                  </IconBtn>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Terminal tabs */}
      <div className="flex min-w-0 flex-1 flex-col bg-bg-base">
        {tabs.length === 0 ? (
          <EmptyState
            icon={<TerminalIcon size={42} />}
            title="No active sessions"
            subtitle="Double-click a server or press its ▶ button to open a terminal."
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
                      'group flex shrink-0 items-center gap-2 border-r border-line px-3.5 py-2 text-[13px]',
                      active === t.tabId
                        ? 'border-t-2 border-t-accent bg-bg-base text-ink'
                        : 'border-t-2 border-t-transparent text-ink-soft hover:bg-bg-hover'
                    )}
                  >
                    <TerminalIcon size={13} style={t.server.color ? { color: t.server.color } : undefined} />
                    <span className="max-w-[140px] truncate">{t.server.name}</span>
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
                  <TerminalView server={t.server} active={active === t.tabId} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {dialog && (
        <ServerDialog projectId={project.id} server={dialog.server} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  danger
}: {
  children: ReactNode
  onClick: () => void
  title: string
  danger?: boolean
}): ReactNode {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-md text-ink-faint hover:bg-bg-elevated',
        danger ? 'hover:text-bad' : 'hover:text-ink'
      )}
    >
      {children}
    </button>
  )
}
