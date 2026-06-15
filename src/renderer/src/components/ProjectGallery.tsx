import { useMemo, useState, type ReactNode } from 'react'
import { Plus, Search, Clock, Server, Database as DbIcon, Pencil, Trash2 } from 'lucide-react'
import { useApp } from '../store'
import { filterProjects, groupProjects, recentProjects, topTags } from '../lib/projects'
import { Button, Chip, cn } from '../lib/ui'
import ProjectDialog from './dialogs/ProjectDialog'
import type { Project } from '@shared/types'

export default function ProjectGallery(): ReactNode {
  const projects = useApp((s) => s.data.projects)
  const select = useApp((s) => s.selectProject)
  const deleteProject = useApp((s) => s.deleteProject)

  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)

  const filtered = useMemo(() => filterProjects(projects, query, tag), [projects, query, tag])
  const groups = useMemo(() => groupProjects(filtered), [filtered])
  const recents = useMemo(
    () => (query || tag ? [] : recentProjects(projects, 4)),
    [projects, query, tag]
  )
  const tags = useMemo(() => {
    const base = topTags(projects, query ? 50 : 6)
    return query ? base.filter((t) => t.includes(query.toLowerCase())) : base
  }, [projects, query])

  return (
    <div className="flex h-full flex-col bg-bg-base">
      <header className="flex items-center justify-between px-8 pb-4 pt-7">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Projects</h1>
          <p className="text-xs text-ink-faint">{projects.length} project(s)</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} /> New project
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3 px-8 pb-4">
        <div className="relative w-80 max-w-full">
          <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-ink-faint" />
          <input
            className="w-full rounded-lg border border-line bg-bg-input py-2 pl-9 pr-3 text-[13px] outline-none placeholder:text-ink-faint focus:border-accent"
            placeholder="Search projects, tags, groups…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <Chip key={t} active={tag === t} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </Chip>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
        {projects.length === 0 && (
          <div className="mt-24 flex flex-col items-center gap-3 text-center text-ink-faint">
            <div className="text-5xl">🗂️</div>
            <div className="text-lg font-semibold text-ink-soft">No projects yet</div>
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} /> Create your first project
            </Button>
          </div>
        )}

        {recents.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
              <Clock size={12} /> Recent
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {recents.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onOpen={() => select(p.id)}
                  onEdit={() => setEditing(p)}
                  onDelete={() => deleteProject(p.id)}
                />
              ))}
            </div>
          </section>
        )}

        {groups.map(({ group, projects: list }) => (
          <section key={group} className="mb-6">
            <h2 className="mb-2.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
              {group}
              <span className="rounded-full bg-bg-elevated px-1.5 text-[10px] font-semibold">
                {list.length}
              </span>
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {list.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onOpen={() => select(p.id)}
                  onEdit={() => setEditing(p)}
                  onDelete={() => deleteProject(p.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {creating && <ProjectDialog onClose={() => setCreating(false)} />}
      {editing && <ProjectDialog project={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function ProjectCard({
  project,
  onOpen,
  onEdit,
  onDelete
}: {
  project: Project
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}): ReactNode {
  return (
    <div
      onClick={onOpen}
      className={cn(
        'group relative cursor-pointer rounded-xl border border-line bg-bg-panel p-4 transition-colors hover:border-accent hover:bg-bg-elevated'
      )}
    >
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          className="rounded-md p-1.5 text-ink-faint hover:bg-bg-hover hover:text-ink"
          title="Edit"
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
        >
          <Pencil size={13} />
        </button>
        <button
          className="rounded-md p-1.5 text-ink-faint hover:bg-bg-hover hover:text-bad"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation()
            if (confirm(`Delete project "${project.name}"?`)) onDelete()
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="mb-1 truncate pr-12 text-[15px] font-bold">{project.name}</div>
      <div className="mb-3 line-clamp-2 h-8 text-xs text-ink-faint">
        {project.description || 'No description'}
      </div>

      <div className="mb-3 flex flex-wrap gap-1">
        {project.tags.slice(0, 4).map((t) => (
          <span
            key={t}
            className="rounded-md bg-accent-dim px-1.5 py-0.5 text-[10px] font-semibold text-accent-hover"
          >
            {t}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-ink-soft">
        <span className="flex items-center gap-1">
          <Server size={12} /> {project.servers.length}
        </span>
        <span className="flex items-center gap-1">
          <DbIcon size={12} /> {project.databases.length}
        </span>
      </div>
    </div>
  )
}
