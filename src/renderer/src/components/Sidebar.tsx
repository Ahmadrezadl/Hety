import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Hexagon,
  Plus,
  Search,
  Clock,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight
} from 'lucide-react'
import { useApp } from '../store'
import { filterProjects, groupProjects, recentProjects } from '../lib/projects'
import { cn, ProjectIcon } from '../lib/ui'
import ProjectDialog from './dialogs/ProjectDialog'
import type { Project } from '@shared/types'

export default function Sidebar(): ReactNode {
  const projects = useApp((s) => s.data.projects)
  const selectedId = useApp((s) => s.selectedProjectId)
  const select = useApp((s) => s.selectProject)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => filterProjects(projects, query, null), [projects, query])
  const groups = useMemo(() => groupProjects(filtered), [filtered])
  const recents = useMemo(() => (query ? [] : recentProjects(projects, 4)), [projects, query])

  const openAndFocusSearch = (): void => {
    setExpanded(true)
    setTimeout(() => searchRef.current?.focus(), 0)
  }

  if (!expanded) {
    return (
      <>
        <aside className="flex h-full w-14 shrink-0 flex-col items-center border-r border-line bg-bg-panel py-3">
          <button className="mb-1" onClick={() => select(null)} title="All projects">
            <Hexagon className="text-accent" size={22} fill="currentColor" fillOpacity={0.15} />
          </button>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-bg-hover hover:text-ink"
            title="Expand sidebar"
            onClick={() => setExpanded(true)}
          >
            <ChevronsRight size={18} />
          </button>
          <button
            className="mb-1 flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-bg-hover hover:text-ink"
            title="Search projects"
            onClick={openAndFocusSearch}
          >
            <Search size={16} />
          </button>
          <div className="my-1 h-px w-7 bg-line" />
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => select(p.id)}
                title={p.name}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-lg ring-1 transition-colors',
                  p.id === selectedId
                    ? 'bg-accent-dim ring-accent'
                    : 'ring-transparent hover:bg-bg-hover'
                )}
              >
                <ProjectIcon icon={p.icon} size={20} className="text-ink-faint" />
              </button>
            ))}
          </div>
          <button
            className="mt-1 flex h-8 w-8 items-center justify-center rounded-md bg-accent text-white hover:bg-accent-hover"
            title="New project"
            onClick={() => setCreating(true)}
          >
            <Plus size={16} />
          </button>
        </aside>
        {creating && <ProjectDialog onClose={() => setCreating(false)} />}
      </>
    )
  }

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-line bg-bg-panel">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <button
          className="flex items-center gap-2"
          onClick={() => select(null)}
          title="All projects"
        >
          <Hexagon className="text-accent" size={20} fill="currentColor" fillOpacity={0.15} />
          <span className="text-[17px] font-extrabold tracking-tight">Hety</span>
        </button>
        <div className="flex items-center gap-1">
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-bg-hover hover:text-ink"
            title="Collapse sidebar"
            onClick={() => setExpanded(false)}
          >
            <ChevronsLeft size={16} />
          </button>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white hover:bg-accent-hover"
            title="New project"
            onClick={() => setCreating(true)}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-ink-faint" />
          <input
            ref={searchRef}
            className="w-full rounded-lg bg-bg-input py-2 pl-8 pr-2 text-[13px] outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-accent"
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {projects.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-ink-faint">
            No projects yet. Create your first one.
          </div>
        )}

        {recents.length > 0 && (
          <Section icon={<Clock size={12} />} label="Recent">
            {recents.map((p) => (
              <ProjectRow key={p.id} project={p} selected={p.id === selectedId} onClick={() => select(p.id)} />
            ))}
          </Section>
        )}

        {groups.map(({ group, projects: list }) => {
          const isCollapsed = collapsed[group]
          return (
            <div key={group} className="mb-1">
              <button
                className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint hover:text-ink-soft"
                onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {group}
                <span className="ml-auto font-medium normal-case">{list.length}</span>
              </button>
              {!isCollapsed &&
                list.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    selected={p.id === selectedId}
                    onClick={() => select(p.id)}
                  />
                ))}
            </div>
          )
        })}
      </div>

      {creating && <ProjectDialog onClose={() => setCreating(false)} />}
    </aside>
  )
}

function Section({
  icon,
  label,
  children
}: {
  icon: ReactNode
  label: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
        {icon}
        {label}
      </div>
      {children}
    </div>
  )
}

function ProjectRow({
  project,
  selected,
  onClick
}: {
  project: Project
  selected: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-accent-dim text-ink' : 'text-ink-soft hover:bg-bg-hover hover:text-ink'
      )}
    >
      <span className="flex w-[18px] shrink-0 justify-center">
        <ProjectIcon
          icon={project.icon}
          size={16}
          className={selected ? 'text-accent' : 'text-ink-faint'}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold">{project.name}</span>
        {(project.servers.length > 0 ||
          project.databases.length > 0 ||
          project.repositories.length > 0) && (
          <span className="block truncate text-[11px] text-ink-faint">
            {project.repositories.length > 0 && `${project.repositories.length} repo · `}
            {project.servers.length} ssh · {project.databases.length} db
          </span>
        )}
      </span>
    </button>
  )
}
