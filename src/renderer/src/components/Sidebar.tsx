import { useMemo, useState, type ReactNode } from 'react'
import { Hexagon, Plus, Search, Clock, Folder, ChevronDown, ChevronRight } from 'lucide-react'
import { useApp } from '../store'
import { filterProjects, groupProjects, recentProjects } from '../lib/projects'
import { cn } from '../lib/ui'
import ProjectDialog from './dialogs/ProjectDialog'
import type { Project } from '@shared/types'

export default function Sidebar(): ReactNode {
  const projects = useApp((s) => s.data.projects)
  const selectedId = useApp((s) => s.selectedProjectId)
  const select = useApp((s) => s.selectProject)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const filtered = useMemo(() => filterProjects(projects, query, null), [projects, query])
  const groups = useMemo(() => groupProjects(filtered), [filtered])
  const recents = useMemo(() => (query ? [] : recentProjects(projects, 4)), [projects, query])

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
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white hover:bg-accent-hover"
          title="New project"
          onClick={() => setCreating(true)}
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-ink-faint" />
          <input
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
      <Folder size={15} className={selected ? 'text-accent' : 'text-ink-faint'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold">{project.name}</span>
        {(project.servers.length > 0 || project.databases.length > 0) && (
          <span className="block truncate text-[11px] text-ink-faint">
            {project.servers.length} ssh · {project.databases.length} db
          </span>
        )}
      </span>
    </button>
  )
}
