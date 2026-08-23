import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Plus,
  Database as DbIcon,
  Pencil,
  Trash2,
  X,
  RotateCw,
  RefreshCw,
  Power,
  Search,
  Bookmark,
  FileCode2,
  History,
  CircleAlert,
  Lock,
  Unlock,
  Copy,
  MoreHorizontal
} from 'lucide-react'
import type { Project, Database, DbSchema, SchemaTable, Server } from '@shared/types'
import { getDatabaseKindInfo } from '@shared/databases'
import { buildSelectAll, quoteQualified } from '@shared/sql'
import { useApp, useOpenRequest, newId } from '../../store'
import { oneLine, relativeTime } from '../../lib/format'
import { cn, EmptyState, StatusDot, colorTint, AnchorMenu } from '../../lib/ui'
import { ResizeHandle, usePersistedSize } from '../../lib/resize'
import DatabaseDialog from '../dialogs/DatabaseDialog'
import DatabaseLogo from './DatabaseLogo'
import SchemaTree from './SchemaTree'
import SqlConsole, { type EditTable } from './SqlConsole'

interface Conn {
  id: string | null
  status: 'idle' | 'connecting' | 'connected' | 'error'
  error?: string
}
interface ConsoleTab {
  tabId: string
  title: string
  initialSql?: string
  autorun?: boolean
  editTable?: EditTable
}

/** Ask a mounted session to open a query tab. */
interface ConsoleRequest {
  token: number
  title: string
  initialSql?: string
  autorun?: boolean
  editTable?: EditTable
}

/** Tab label for a console reopened from history: the first few words of the SQL. */
function historyTitle(sql: string): string {
  const flat = oneLine(sql)
  return flat.length > 24 ? flat.slice(0, 24) + '…' : flat
}

function RailTab({
  active,
  icon,
  label,
  count,
  onClick
}: {
  active: boolean
  icon: ReactNode
  label: string
  count?: number
  onClick: () => void
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors',
        active ? 'bg-bg-elevated text-ink' : 'text-ink-faint hover:text-ink-soft'
      )}
    >
      {icon}
      {label}
      {count !== undefined && count > 0 && (
        <span className="font-medium normal-case opacity-60">{count}</span>
      )}
    </button>
  )
}

const STATUS_COLOR: Record<Conn['status'], string> = {
  idle: '#646b78',
  connecting: '#e0b341',
  connected: '#46c08a',
  error: '#e0625e'
}

export default function DbPanel({ project }: { project: Project }): ReactNode {
  const deleteDatabase = useApp((s) => s.deleteDatabase)
  const savedQueries = useApp((s) => s.data.savedQueries)
  const deleteSavedQuery = useApp((s) => s.deleteSavedQuery)
  const queryHistory = useApp((s) => s.data.queryHistory)
  const deleteQueryHistory = useApp((s) => s.deleteQueryHistory)
  const clearQueryHistory = useApp((s) => s.clearQueryHistory)

  const [selectedDbId, setSelectedDbId] = useState<string | null>(null)
  const [opened, setOpened] = useState<string[]>([])
  const [statuses, setStatuses] = useState<Record<string, Conn['status']>>({})
  const [consoleReqs, setConsoleReqs] = useState<Record<string, ConsoleRequest>>({})
  /** Saved query id to open once that database session finishes connecting. */
  const [pendingQueries, setPendingQueries] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState<{ database?: Database; duplicateFrom?: Database } | null>(null)
  const [rail, setRail] = useState<'saved' | 'history'>('saved')
  const [savedSearch, setSavedSearch] = useState('')
  const [historySearch, setHistorySearch] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<{
    top: number
    bottom: number
    left: number
    right: number
  } | null>(null)
  const [railW, setRailW] = usePersistedSize('db.rail', 240, 180, 420)
  const [schemaW, setSchemaW] = usePersistedSize('db.schema', 240, 160, 420)

  const selectedDb = project.databases.find((d) => d.id === selectedDbId) ?? null

  const select = (database: Database): void => {
    setSelectedDbId(database.id)
    setOpened((o) => (o.includes(database.id) ? o : [...o, database.id]))
  }

  const closeSession = (dbId: string): void => {
    setOpened((prev) => {
      const next = prev.filter((id) => id !== dbId)
      setSelectedDbId((cur) => (cur === dbId ? (next[next.length - 1] ?? null) : cur))
      return next
    })
    setStatuses((s) => {
      const { [dbId]: _, ...rest } = s
      return rest
    })
    setConsoleReqs((r) => {
      const { [dbId]: _, ...rest } = r
      return rest
    })
    setPendingQueries((p) => {
      const { [dbId]: _, ...rest } = p
      return rest
    })
  }

  // Drop sessions for databases deleted from the project.
  useEffect(() => {
    const ids = new Set(project.databases.map((d) => d.id))
    const gone = opened.filter((id) => !ids.has(id))
    if (!gone.length) return
    setOpened((prev) => {
      const next = prev.filter((id) => ids.has(id))
      setSelectedDbId((cur) => (cur && !ids.has(cur) ? (next[next.length - 1] ?? null) : cur))
      return next
    })
    setStatuses((s) => {
      const next = { ...s }
      for (const id of gone) delete next[id]
      return next
    })
    setConsoleReqs((r) => {
      const next = { ...r }
      for (const id of gone) delete next[id]
      return next
    })
    setPendingQueries((p) => {
      const next = { ...p }
      for (const id of gone) delete next[id]
      return next
    })
  }, [project.databases, opened])

  const requestConsole = (
    dbId: string,
    title: string,
    initialSql = '',
    autorun = false,
    editTable?: EditTable
  ): void => {
    setConsoleReqs((r) => ({
      ...r,
      [dbId]: { token: Date.now(), title, initialSql, autorun, editTable }
    }))
  }

  // Command palette: select a database, or open a saved query on the one it belongs to.
  useOpenRequest(project.id, 'db', ({ kind, id }) => {
    if (!id) return
    if (kind === 'database') {
      const database = project.databases.find((d) => d.id === id)
      if (database) select(database)
      return
    }
    if (kind !== 'query') return
    const sq = savedQueries.find((q) => q.id === id)
    if (!sq) return

    const target =
      sq.databaseId && project.databases.some((d) => d.id === sq.databaseId)
        ? sq.databaseId
        : selectedDbId

    if (!target) return
    const database = project.databases.find((d) => d.id === target)
    if (!database) return

    select(database)
    if (statuses[target] === 'connected') {
      requestConsole(target, sq.name, sq.sql, false)
    } else {
      setPendingQueries((p) => ({ ...p, [target]: sq.id }))
    }
  })

  const filteredSaved = useMemo(() => {
    const q = savedSearch.toLowerCase().trim()
    return savedQueries.filter(
      (sq) => !q || sq.name.toLowerCase().includes(q) || sq.sql.toLowerCase().includes(q)
    )
  }, [savedQueries, savedSearch])

  /** History for the selected database only — the log is shared across projects. */
  const history = useMemo(
    () => (selectedDbId ? (queryHistory ?? []).filter((h) => h.databaseId === selectedDbId) : []),
    [queryHistory, selectedDbId]
  )

  const filteredHistory = useMemo(() => {
    const q = historySearch.toLowerCase().trim()
    return q ? history.filter((h) => h.sql.toLowerCase().includes(q)) : history
  }, [history, historySearch])

  return (
    <div className="flex h-full">
      {/* Rail: databases + saved queries */}
      <div
        style={{ width: railW }}
        className="flex shrink-0 flex-col border-r border-line bg-bg-panel"
      >
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Databases</span>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-soft hover:bg-bg-hover hover:text-ink"
            title="Add database"
            onClick={() => setDialog({})}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="max-h-[45%] overflow-y-auto px-2">
          {project.databases.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-ink-faint">No databases yet.</p>
          )}
          {project.databases.map((d) => {
            const info = getDatabaseKindInfo(d.kind)
            const location = info.supportsHost
              ? `${d.host}/${d.database}`
              : d.database || `${info.name} profile`
            const bg = colorTint(d.color)
            const hoverBg = colorTint(d.color, 0.22)
            const status = statuses[d.id] ?? 'idle'

            return (
              <div
                key={d.id}
                className={cn(
                  'group relative mb-1 rounded-lg px-2.5 py-2 transition-colors',
                  !d.color && (selectedDbId === d.id ? 'bg-accent-dim' : 'hover:bg-bg-hover'),
                  d.color && selectedDbId === d.id && 'ring-1 ring-accent/40'
                )}
                style={
                  d.color
                    ? {
                        backgroundColor: selectedDbId === d.id ? hoverBg : bg,
                        borderLeft: `3px solid ${d.color}`,
                        paddingLeft: 7
                      }
                    : undefined
                }
                onMouseEnter={(e) => {
                  if (hoverBg && selectedDbId !== d.id) e.currentTarget.style.backgroundColor = hoverBg
                }}
                onMouseLeave={(e) => {
                  if (bg && selectedDbId !== d.id) e.currentTarget.style.backgroundColor = bg
                }}
              >
                <button
                  className="flex w-full min-w-0 items-center gap-2 pr-7 text-left"
                  onClick={() => {
                    if (opened.includes(d.id)) setSelectedDbId(d.id)
                  }}
                  onDoubleClick={() => select(d)}
                >
                  <span className="relative shrink-0">
                    <DatabaseLogo kind={d.kind} size={19} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate text-[13px] font-semibold">{d.name}</span>
                      {status !== 'idle' && <StatusDot color={STATUS_COLOR[status]} />}
                      {d.locked && <Lock size={11} className="shrink-0 text-warn" />}
                    </span>
                    <span className="block truncate text-[11px] text-ink-faint">
                      {info.name} - {d.useSsh ? 'ssh - ' : ''}
                      {location}
                    </span>
                  </span>
                </button>
                <button
                  title="Actions"
                  className={cn(
                    'absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint transition-opacity hover:bg-black/10 hover:text-ink',
                    menuId === d.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (menuId === d.id) {
                      setMenuId(null)
                      setMenuAnchor(null)
                      return
                    }
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenuId(d.id)
                    setMenuAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })
                  }}
                >
                  <MoreHorizontal size={15} />
                </button>
                {menuId === d.id && menuAnchor && (
                  <DatabaseMenu
                    anchor={menuAnchor}
                    onClose={() => {
                      setMenuId(null)
                      setMenuAnchor(null)
                    }}
                    onEdit={() => setDialog({ database: d })}
                    onDuplicate={() => setDialog({ duplicateFrom: d })}
                    onDelete={() => {
                      if (confirm(`Delete database "${d.name}"?`)) {
                        closeSession(d.id)
                        deleteDatabase(project.id, d.id)
                      }
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* Saved queries / history */}
        <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-line">
          <div className="flex items-center gap-1 px-2 pt-2">
            <RailTab
              active={rail === 'saved'}
              icon={<Bookmark size={11} />}
              label="Saved"
              onClick={() => setRail('saved')}
            />
            <RailTab
              active={rail === 'history'}
              icon={<History size={11} />}
              label="History"
              count={history.length}
              onClick={() => setRail('history')}
            />
            {rail === 'history' && history.length > 0 && (
              <button
                title="Clear history for this database"
                className="ml-auto rounded p-1 text-ink-faint hover:bg-bg-hover hover:text-bad"
                onClick={() => {
                  if (confirm('Clear the query history for this database?'))
                    clearQueryHistory(selectedDbId ?? undefined)
                }}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>

          <div className="px-2 pb-1 pt-1.5">
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2 top-2 text-ink-faint" />
              <input
                className="w-full rounded-md bg-bg-input py-1.5 pl-7 pr-2 text-xs outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-accent"
                placeholder={rail === 'saved' ? 'Search queries...' : 'Search history...'}
                value={rail === 'saved' ? savedSearch : historySearch}
                onChange={(e) =>
                  rail === 'saved' ? setSavedSearch(e.target.value) : setHistorySearch(e.target.value)
                }
              />
            </div>
          </div>

          {rail === 'saved' ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {filteredSaved.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-ink-faint">No saved queries.</p>
              )}
              {filteredSaved.map((sq) => (
                <div
                  key={sq.id}
                  className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-bg-hover"
                  title={sq.sql}
                >
                  <FileCode2 size={12} className="shrink-0 text-ink-faint" />
                  <button
                    className="min-w-0 flex-1 truncate text-left text-[12px]"
                    onClick={() => {
                      if (!selectedDbId) return
                      requestConsole(selectedDbId, sq.name, sq.sql, false)
                    }}
                  >
                    {sq.databaseId === selectedDbId && <span className="text-accent">* </span>}
                    {sq.name}
                  </button>
                  <button
                    className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:text-bad group-hover:opacity-100"
                    title="Delete"
                    onClick={() => deleteSavedQuery(sq.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {filteredHistory.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-ink-faint">
                  {selectedDb
                    ? history.length === 0
                      ? 'Nothing run yet on this database.'
                      : 'No matches.'
                    : 'Select a database to see its history.'}
                </p>
              )}
              {filteredHistory.map((h) => (
                <div
                  key={h.id}
                  className="group rounded-md px-2 py-1.5 hover:bg-bg-hover"
                  title={h.error ? `${h.sql}\n\n${h.error}` : h.sql}
                >
                  <div className="flex items-start gap-1.5">
                    <span className="mt-[3px] shrink-0">
                      {h.error ? (
                        <CircleAlert size={12} className="text-bad" />
                      ) : (
                        <History size={12} className="text-ink-faint" />
                      )}
                    </span>
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        if (!selectedDbId) return
                        requestConsole(selectedDbId, historyTitle(h.sql), h.sql, false)
                      }}
                    >
                      <span className="block truncate font-mono text-[11px] text-ink">
                        {oneLine(h.sql)}
                      </span>
                      <span className="block truncate text-[10px] text-ink-faint">
                        {relativeTime(h.ranAt)} ·{' '}
                        {h.error ? 'failed' : `${h.rowCount ?? 0} rows · ${h.elapsedMs} ms`}
                      </span>
                    </button>
                    <button
                      className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:text-bad group-hover:opacity-100"
                      title="Remove from history"
                      onClick={() => deleteQueryHistory(h.id)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <ResizeHandle axis="x" size={railW} onResize={setRailW} />

      {/* Main workspace */}
      <div className="flex min-w-0 flex-1 flex-col">
        {opened.length === 0 || !selectedDb ? (
          <EmptyState
            icon={<DbIcon size={42} />}
            title="Select a database"
            subtitle="Double-click a connection on the left to open it, or add a new one."
          />
        ) : (
          <>
            <div className="flex items-stretch border-b border-line bg-bg-panel">
              <div className="flex min-w-0 flex-1 overflow-x-auto">
                {opened.map((id) => {
                  const database = project.databases.find((d) => d.id === id)
                  if (!database) return null
                  const status = statuses[id] ?? 'idle'
                  const isActive = id === selectedDbId
                  return (
                    <button
                      key={id}
                      onClick={() => setSelectedDbId(id)}
                      className={cn(
                        'group flex shrink-0 items-center gap-2 border-r border-t-2 border-line px-3.5 py-2 text-[13px]',
                        isActive
                          ? 'border-t-accent bg-bg-base text-ink'
                          : 'border-t-transparent text-ink-soft hover:bg-bg-hover'
                      )}
                    >
                      <DatabaseLogo kind={database.kind} size={14} />
                      <span
                        className="max-w-[140px] truncate rounded px-1.5 py-0.5"
                        style={
                          database.color
                            ? {
                                backgroundColor: colorTint(
                                  database.color,
                                  isActive ? 0.22 : 0.14
                                )
                              }
                            : undefined
                        }
                      >
                        {database.name}
                      </span>
                      {status !== 'idle' && <StatusDot color={STATUS_COLOR[status]} />}
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

            <div className="relative min-h-0 flex-1">
              {opened.map((id) => {
                const database = project.databases.find((d) => d.id === id)
                if (!database) return null
                const shown = id === selectedDbId
                const server = database.useSsh
                  ? project.servers.find((s) => s.id === database.sshServerId)
                  : undefined
                return (
                  <div key={id} className={cn('absolute inset-0', shown ? 'block' : 'hidden')}>
                    <DbSession
                      project={project}
                      database={database}
                      server={server}
                      schemaW={schemaW}
                      onSchemaResize={setSchemaW}
                      consoleRequest={consoleReqs[id]}
                      onConsoleRequestHandled={() =>
                        setConsoleReqs((r) => {
                          const { [id]: _, ...rest } = r
                          return rest
                        })
                      }
                      pendingQueryId={pendingQueries[id]}
                      onPendingQueryConsumed={() =>
                        setPendingQueries((p) => {
                          const { [id]: _, ...rest } = p
                          return rest
                        })
                      }
                      onStatus={(status) =>
                        setStatuses((s) => (s[id] === status ? s : { ...s, [id]: status }))
                      }
                      onEdit={() => setDialog({ database })}
                    />
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {dialog && (
        <DatabaseDialog
          project={project}
          database={dialog.database}
          duplicateFrom={dialog.duplicateFrom}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

function DbSession({
  project,
  database,
  server,
  schemaW,
  onSchemaResize,
  consoleRequest,
  onConsoleRequestHandled,
  pendingQueryId,
  onPendingQueryConsumed,
  onStatus,
  onEdit
}: {
  project: Project
  database: Database
  server: Server | undefined
  schemaW: number
  onSchemaResize: (w: number) => void
  consoleRequest?: ConsoleRequest
  onConsoleRequestHandled: () => void
  pendingQueryId?: string
  onPendingQueryConsumed: () => void
  onStatus: (status: Conn['status']) => void
  onEdit: () => void
}): ReactNode {
  const upsertDatabase = useApp((s) => s.upsertDatabase)
  const savedQueries = useApp((s) => s.data.savedQueries)
  const addSavedQuery = useApp((s) => s.addSavedQuery)
  const addQueryHistory = useApp((s) => s.addQueryHistory)
  const setLive = useApp((s) => s.setLive)

  const [conn, setConn] = useState<Conn>({ id: null, status: 'idle' })
  const [schema, setSchema] = useState<DbSchema | undefined>()
  const [tabs, setTabs] = useState<ConsoleTab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [gen, setGen] = useState(0)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  const dbInfo = getDatabaseKindInfo(database.kind)
  const supported = dbInfo.supported

  useEffect(() => {
    onStatusRef.current(conn.status)
  }, [conn.status])

  useEffect(() => {
    const key = conn.id ?? `db-${database.id}`
    setLive('db', project.id, key, conn.status === 'connected' && !!conn.id)
    return () => setLive('db', project.id, key, false)
  }, [conn.status, conn.id, project.id, database.id, setLive])

  // Server-side idle disconnects (network drop, tunnel death, etc.).
  useEffect(() => {
    return window.api.db.onStatus((p) => {
      setConn((c) => {
        if (!c.id || c.id !== p.id) return c
        return { id: null, status: 'error', error: p.message || 'Connection lost' }
      })
    })
  }, [])

  const openConsole = useCallback(
    (title: string, initialSql = '', autorun = false, editTable?: EditTable): void => {
      const tabId = newId()
      setTabs((t) => [...t, { tabId, title, initialSql, autorun, editTable }])
      setActive(tabId)
    },
    []
  )

  const closeTab = (tabId: string): void => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.tabId !== tabId)
      setActive((a) => (a === tabId ? (next[next.length - 1]?.tabId ?? null) : a))
      return next
    })
  }

  // Open a pending saved query once connected (covers both mid-connect and already-live).
  useEffect(() => {
    if (!pendingQueryId || conn.status !== 'connected') return
    const sq = savedQueries.find((q) => q.id === pendingQueryId)
    onPendingQueryConsumed()
    if (!sq) return
    setTabs((prev) => {
      const blankOnly =
        prev.length === 1 &&
        prev[0].title === 'Query' &&
        !prev[0].initialSql &&
        !prev[0].editTable
      const tabId = newId()
      setActive(tabId)
      const tab = { tabId, title: sq.name, initialSql: sq.sql }
      return blankOnly ? [tab] : [...prev, tab]
    })
  }, [pendingQueryId, conn.status, savedQueries, onPendingQueryConsumed])

  // (Re)connect when this session mounts or reconnect is requested.
  useEffect(() => {
    if (!supported) {
      setConn({ id: null, status: 'idle' })
      return
    }

    let cancelled = false
    let cid: string | null = null
    setSchema(undefined)
    setConn({ id: null, status: 'connecting' })
    ;(async () => {
      const r = await window.api.db.connect(database, server)
      if (cancelled) {
        if (r.ok && r.data) window.api.db.disconnect(r.data)
        return
      }
      if (!r.ok) {
        setConn({ id: null, status: 'error', error: r.error })
        return
      }
      cid = r.data!
      setConn({ id: cid, status: 'connected' })
      if (database.locked) void window.api.db.setReadOnly(cid, true)

      if (tabsRef.current.length === 0) {
        const dt = newId()
        setTabs([{ tabId: dt, title: 'Query' }])
        setActive(dt)
      }

      const sc = await window.api.db.introspect(cid)
      if (!cancelled && sc.ok && sc.data) setSchema(sc.data)
    })()
    return () => {
      cancelled = true
      if (cid) window.api.db.disconnect(cid)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database.id, database.kind, gen])

  // Open console tabs requested from the rail / palette.
  useEffect(() => {
    if (!consoleRequest) return
    openConsole(
      consoleRequest.title,
      consoleRequest.initialSql,
      consoleRequest.autorun,
      consoleRequest.editTable
    )
    onConsoleRequestHandled()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consoleRequest?.token])

  const refreshSchema = async (): Promise<void> => {
    if (!conn.id) return
    const sc = await window.api.db.introspect(conn.id)
    if (sc.ok && sc.data) setSchema(sc.data)
  }

  const toggleLock = async (): Promise<void> => {
    const locked = !database.locked
    upsertDatabase(project.id, { ...database, locked })
    if (conn.id) await window.api.db.setReadOnly(conn.id, locked)
  }

  const openTable = (schemaName: string, table: SchemaTable): void => {
    const qualified = quoteQualified(database.kind, schemaName, table.name)
    const sql = buildSelectAll(database.kind, schemaName, table.name)
    openConsole(table.name, sql, true, {
      table: qualified,
      schema: schemaName,
      name: table.name,
      columns: table.columns
    })
  }

  const onSave = (name: string, sql: string): void => {
    addSavedQuery({
      id: newId(),
      name,
      sql,
      projectId: project.id,
      databaseId: database.id,
      createdAt: Date.now()
    })
  }

  const recordRun = (run: {
    sql: string
    elapsedMs: number
    rowCount?: number
    error?: string
  }): void => {
    addQueryHistory({
      id: newId(),
      sql: run.sql,
      projectId: project.id,
      databaseId: database.id,
      databaseName: database.name,
      ranAt: Date.now(),
      elapsedMs: run.elapsedMs,
      rowCount: run.rowCount,
      error: run.error
    })
  }

  if (!supported) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-bg-panel px-4 py-2">
          <DatabaseLogo kind={database.kind} size={18} />
          <span
            className="rounded-md px-1.5 py-0.5 text-[14px] font-bold"
            style={
              database.color ? { backgroundColor: colorTint(database.color, 0.22) } : undefined
            }
          >
            {database.name}
          </span>
          <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold text-warn">
            PROFILE ONLY
          </span>
          <span className="text-[11px] text-ink-soft">{dbInfo.name}</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
              onClick={onEdit}
            >
              <Pencil size={14} /> Edit
            </button>
          </div>
        </div>
        <EmptyState
          icon={<DatabaseLogo kind={database.kind} size={44} />}
          title={`${dbInfo.name} profile`}
          subtitle="This database type can be selected and saved, but live connections, schema browsing, and query execution are not wired in this build yet."
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-bg-panel px-4 py-2">
        <DatabaseLogo kind={database.kind} size={18} />
        <span
          className="rounded-md px-1.5 py-0.5 text-[14px] font-bold"
          style={
            database.color ? { backgroundColor: colorTint(database.color, 0.22) } : undefined
          }
        >
          {database.name}
        </span>
        <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] font-bold text-ink-soft">
          {dbInfo.name}
        </span>
        {database.locked && (
          <span className="flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold text-warn">
            <Lock size={10} /> LOCKED
          </span>
        )}
        <StatusDot color={STATUS_COLOR[conn.status]} />
        <span className="text-[11px] text-ink-soft">
          {conn.status === 'connected'
            ? 'Connected'
            : conn.status === 'connecting'
              ? 'Connecting...'
              : conn.status === 'error'
                ? `Error: ${conn.error}`
                : 'Disconnected'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ToolBtn
            title={database.locked ? 'Unlock (allow writes)' : 'Lock (read-only)'}
            onClick={toggleLock}
          >
            {database.locked ? <Lock size={13} className="text-warn" /> : <Unlock size={13} />}
          </ToolBtn>
          <ToolBtn title="Refresh schema" onClick={refreshSchema} disabled={conn.status !== 'connected'}>
            <RefreshCw size={13} />
          </ToolBtn>
          <ToolBtn title="Reconnect" onClick={() => setGen((g) => g + 1)}>
            <RotateCw size={13} />
          </ToolBtn>
          <ToolBtn
            title="Disconnect"
            onClick={() => {
              if (conn.id) window.api.db.disconnect(conn.id)
              setConn({ id: null, status: 'idle' })
              setSchema(undefined)
            }}
            disabled={conn.status !== 'connected'}
          >
            <Power size={13} />
          </ToolBtn>
          <button
            className="ml-1 flex items-center gap-1 rounded-md border border-line bg-bg-elevated px-2 py-1 text-[12px] font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
            onClick={() => openConsole('Query')}
          >
            <Plus size={13} /> New Query
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          style={{ width: schemaW }}
          className="shrink-0 overflow-auto border-r border-line bg-bg-panel"
        >
          <SchemaTree
            dbName={database.database}
            kind={database.kind}
            schema={schema}
            onOpenTable={openTable}
          />
        </div>
        <ResizeHandle axis="x" size={schemaW} onResize={onSchemaResize} />

        <div className="flex min-w-0 flex-1 flex-col bg-bg-base">
          {tabs.length === 0 ? (
            <EmptyState icon={<FileCode2 size={36} />} title="No query open" subtitle="Press New Query." />
          ) : (
            <>
              <div className="flex items-stretch overflow-x-auto border-b border-line bg-bg-panel">
                {tabs.map((t) => {
                  const color = database.color
                  return (
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
                      <FileCode2 size={12} style={color ? { color } : undefined} />
                      <span
                        className="max-w-[140px] truncate rounded px-1.5 py-0.5"
                        style={
                          color
                            ? {
                                backgroundColor: colorTint(
                                  color,
                                  active === t.tabId ? 0.22 : 0.14
                                )
                              }
                            : undefined
                        }
                      >
                        {t.title}
                      </span>
                      {conn.status === 'connected' && <StatusDot color="#46c08a" />}
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
                  )
                })}
              </div>
              <div className="relative min-h-0 flex-1">
                {tabs.map((t) => (
                  <div
                    key={t.tabId}
                    className={cn('absolute inset-0', active === t.tabId ? 'block' : 'hidden')}
                  >
                    <SqlConsole
                      connectionId={conn.id}
                      connected={conn.status === 'connected'}
                      kind={database.kind}
                      dbName={database.database}
                      schema={schema}
                      initialSql={t.initialSql}
                      autorun={t.autorun}
                      editTable={t.editTable}
                      locked={!!database.locked}
                      onSave={onSave}
                      onExecuted={recordRun}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ToolBtn({
  children,
  onClick,
  title,
  disabled
}: {
  children: ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
}): ReactNode {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-bg-hover hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  )
}

function DatabaseMenu({
  anchor,
  onClose,
  onEdit,
  onDuplicate,
  onDelete
}: {
  anchor: { top: number; bottom: number; left: number; right: number }
  onClose: () => void
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
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-bg-hover"
        onClick={() => {
          onEdit()
          onClose()
        }}
      >
        <Pencil size={13} /> Edit
      </button>
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-bg-hover"
        onClick={() => {
          onDuplicate()
          onClose()
        }}
      >
        <Copy size={13} /> Duplicate
      </button>
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-bad hover:bg-bg-hover"
        onClick={() => {
          onDelete()
          onClose()
        }}
      >
        <Trash2 size={13} /> Delete
      </button>
    </AnchorMenu>
  )
}
