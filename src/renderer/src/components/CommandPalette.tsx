import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Search,
  Terminal,
  ServerCog,
  GitBranch,
  Database as DbIcon,
  Columns3,
  Plus,
  LayoutGrid,
  FileCode2,
  CornerDownLeft
} from 'lucide-react'
import { useApp, type WorkspaceTab, type OpenTargetKind } from '../store'
import { getDatabaseKindInfo } from '@shared/databases'
import { matchCommand } from '../lib/fuzzy'
import { cn, ProjectIcon } from '../lib/ui'
import ProjectDialog from './dialogs/ProjectDialog'

interface Item {
  id: string
  title: string
  /** Shown dimmed under the title, and searchable as a fallback. */
  context: string
  group: string
  icon: ReactNode
  /** Accent dot, e.g. a production server's colour. */
  color?: string
  /** Ordering when nothing has been typed yet — higher comes first. */
  rank: number
  run: () => void
}

/** An item plus where the query matched its title. */
type Result = Item & { positions?: number[] }

const MAX_RESULTS = 60

const TAB_ICON: Record<WorkspaceTab, ReactNode> = {
  ssh: <Terminal size={15} />,
  ops: <ServerCog size={15} />,
  db: <DbIcon size={15} />,
  repo: <GitBranch size={15} />,
  board: <Columns3 size={15} />
}
const TAB_LABEL: Record<WorkspaceTab, string> = {
  ssh: 'SSH',
  ops: 'Remote',
  db: 'Database',
  repo: 'Repository',
  board: 'Planning'
}

export default function CommandPalette(): ReactNode {
  const open = useApp((s) => s.paletteOpen)
  const setOpen = useApp((s) => s.setPaletteOpen)
  const ready = useApp((s) => s.ready)

  // Ctrl/Cmd+K anywhere. Capture phase with stopPropagation so the key never
  // reaches an xterm terminal or the SQL editor, which would both consume it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(!useApp.getState().paletteOpen)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setOpen])

  if (!ready || !open) return null
  return <Palette onClose={() => setOpen(false)} />
}

function Palette({ onClose }: { onClose: () => void }): ReactNode {
  const projects = useApp((s) => s.data.projects)
  const savedQueries = useApp((s) => s.data.savedQueries)
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const select = useApp((s) => s.selectProject)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const requestOpen = useApp((s) => s.requestOpen)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [creating, setCreating] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const goto = (
      projectId: string,
      tab: WorkspaceTab,
      targetKind?: OpenTargetKind,
      targetId?: string
    ): (() => void) => (): void => requestOpen({ projectId, tab, targetKind, targetId })

    // Current project's tabs first — the most likely thing to want.
    const current = projects.find((p) => p.id === selectedProjectId)
    if (current) {
      for (const tab of Object.keys(TAB_LABEL) as WorkspaceTab[]) {
        out.push({
          id: `tab:${tab}`,
          title: TAB_LABEL[tab],
          context: current.name,
          group: 'Go to',
          icon: TAB_ICON[tab],
          rank: 1000,
          run: () => {
            setActiveTab(current.id, tab)
            onClose()
          }
        })
      }
    }

    for (const p of projects) {
      const bits = [p.group, p.description, ...p.tags].filter(Boolean)
      out.push({
        id: `project:${p.id}`,
        title: p.name,
        context: bits.join(' · '),
        group: 'Project',
        icon: <ProjectIcon icon={p.icon} size={15} />,
        rank: 500 + Math.min(p.lastOpenedAt / 1e12, 1),
        run: () => {
          select(p.id)
          onClose()
        }
      })

      for (const s of p.servers) {
        const where = `${s.username}@${s.host}:${s.port} · ${p.name}`
        out.push({
          id: `ssh:${s.id}`,
          title: s.name,
          context: where,
          group: 'SSH',
          icon: TAB_ICON.ssh,
          color: s.color,
          rank: 300,
          run: goto(p.id, 'ssh', 'server', s.id)
        })
        out.push({
          id: `ops:${s.id}`,
          title: s.name,
          context: `Files, monitor, services · ${where}`,
          group: 'Remote',
          icon: TAB_ICON.ops,
          color: s.color,
          rank: 200,
          run: goto(p.id, 'ops', 'server', s.id)
        })
      }

      for (const d of p.databases) {
        out.push({
          id: `db:${d.id}`,
          title: d.name,
          context: `${getDatabaseKindInfo(d.kind).name} · ${d.host || d.database} · ${p.name}`,
          group: 'Database',
          icon: TAB_ICON.db,
          color: d.color,
          rank: 300,
          run: goto(p.id, 'db', 'database', d.id)
        })
      }

      for (const r of p.repositories ?? []) {
        out.push({
          id: `repo:${r.id}`,
          title: r.name,
          context: `${r.path} · ${p.name}`,
          group: 'Repository',
          icon: TAB_ICON.repo,
          rank: 300,
          run: goto(p.id, 'repo', 'repository', r.id)
        })
      }
    }

    for (const q of savedQueries) {
      const project = projects.find((p) => p.id === q.projectId)
      if (!project) continue
      const db = project.databases.find((d) => d.id === q.databaseId)
      out.push({
        id: `query:${q.id}`,
        title: q.name,
        context: [db?.name, project.name].filter(Boolean).join(' · '),
        group: 'Query',
        icon: <FileCode2 size={15} />,
        rank: 250,
        run: goto(project.id, 'db', 'query', q.id)
      })
    }

    out.push({
      id: 'action:gallery',
      title: 'All projects',
      context: 'Back to the project gallery',
      group: 'Action',
      icon: <LayoutGrid size={15} />,
      rank: 100,
      run: () => {
        select(null)
        onClose()
      }
    })
    out.push({
      id: 'action:new-project',
      title: 'New project',
      context: 'Create a project',
      group: 'Action',
      icon: <Plus size={15} />,
      rank: 100,
      run: () => setCreating(true)
    })

    return out
  }, [projects, savedQueries, selectedProjectId, select, setActiveTab, requestOpen, onClose])

  const results = useMemo<Result[]>(() => {
    const q = query.trim()
    if (!q) {
      return [...items]
        .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title))
        .slice(0, MAX_RESULTS)
    }
    const scored: { item: Item; score: number; positions: number[] }[] = []
    for (const item of items) {
      const m = matchCommand(q, item.title, `${item.context} ${item.group}`)
      // rank breaks ties between equally good textual matches.
      if (m) scored.push({ item, score: m.score + item.rank / 1000, positions: m.positions })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, MAX_RESULTS).map((s) => ({ ...s.item, positions: s.positions }))
  }, [items, query])

  useEffect(() => setIndex(0), [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const run = (i: number): void => {
    const item = results[i]
    if (item) item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      setIndex((i) => (results.length ? (i + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault()
      setIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setIndex(Math.max(0, results.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(index)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (creating) return <ProjectDialog onClose={onClose} />

  const showHeaders = !query.trim()
  let lastGroup = ''

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center bg-black/55 pt-[12vh] backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[640px] flex-col overflow-hidden rounded-xl border border-line bg-bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search projects, servers, databases, repositories…"
            className="w-full bg-transparent py-3.5 text-[14px] outline-none placeholder:text-ink-faint"
          />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 && (
            <div className="px-3 py-10 text-center text-[13px] text-ink-faint">No matches.</div>
          )}
          {results.map((item, i) => {
            const header = showHeaders && item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {header && (
                  <div className="px-2.5 pb-1 pt-2.5 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                    {header}
                  </div>
                )}
                <button
                  data-idx={i}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => run(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    i === index ? 'bg-accent-dim text-ink' : 'text-ink-soft hover:bg-bg-hover'
                  )}
                >
                  <span
                    className={cn('flex w-[18px] shrink-0 justify-center', i === index ? 'text-accent' : 'text-ink-faint')}
                  >
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      {item.color && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: item.color }}
                        />
                      )}
                      <span className="truncate text-[13px] font-semibold">
                        <Highlight text={item.title} positions={item.positions} />
                      </span>
                    </span>
                    {item.context && (
                      <span className="block truncate text-[11px] text-ink-faint">{item.context}</span>
                    )}
                  </span>
                  {!showHeaders && (
                    <span className="shrink-0 rounded-md bg-bg-elevated px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">
                      {item.group}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[10px] text-ink-faint">
          <Key label="↑↓" text="navigate" />
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line bg-bg-elevated px-1 py-0.5 font-sans">
              <CornerDownLeft size={9} />
            </kbd>
            open
          </span>
          <Key label="esc" text="close" />
          <span className="ml-auto">{results.length} result{results.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  )
}

function Key({ label, text }: { label: string; text: string }): ReactNode {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded border border-line bg-bg-elevated px-1 py-0.5 font-sans">{label}</kbd>
      {text}
    </span>
  )
}

/** Bold the characters the query matched. */
function Highlight({ text, positions }: { text: string; positions?: number[] }): ReactNode {
  if (!positions || positions.length === 0) return <>{text}</>
  const set = new Set(positions)
  const parts: ReactNode[] = []
  let run = ''
  let runHit = set.has(0)
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i)
    if (hit !== runHit && run) {
      parts.push(
        runHit ? (
          <span key={i} className="text-accent">
            {run}
          </span>
        ) : (
          run
        )
      )
      run = ''
    }
    runHit = hit
    run += text[i]
  }
  if (run)
    parts.push(
      runHit ? (
        <span key="last" className="text-accent">
          {run}
        </span>
      ) : (
        run
      )
    )
  return <>{parts}</>
}
