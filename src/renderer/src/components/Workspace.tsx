import { useState, type ReactNode } from 'react'
import { ChevronLeft, Terminal, GitBranch, Database as DbIcon, Pencil, Trash2 } from 'lucide-react'
import { useApp } from '../store'
import { cn } from '../lib/ui'
import SshPanel from './ssh/SshPanel'
import RepoPanel from './repo/RepoPanel'
import DbPanel from './db/DbPanel'
import ProjectDialog from './dialogs/ProjectDialog'

type Tab = 'ssh' | 'repo' | 'db'

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'ssh', label: 'SSH', icon: <Terminal size={15} /> },
  { id: 'repo', label: 'Repository', icon: <GitBranch size={15} /> },
  { id: 'db', label: 'Database', icon: <DbIcon size={15} /> }
]

export default function Workspace(): ReactNode {
  const project = useApp((s) => s.data.projects.find((p) => p.id === s.selectedProjectId))
  const select = useApp((s) => s.selectProject)
  const deleteProject = useApp((s) => s.deleteProject)
  const [tab, setTab] = useState<Tab>('ssh')
  const [editing, setEditing] = useState(false)

  if (!project) return null

  return (
    <div className="flex h-full flex-col bg-bg-base">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-bg-hover hover:text-ink"
          title="All projects"
          onClick={() => select(null)}
        >
          <ChevronLeft size={18} />
        </button>

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[17px] font-bold">{project.name}</h1>
            {project.group && (
              <span className="rounded-md bg-bg-elevated px-1.5 py-0.5 text-[10px] font-semibold text-ink-soft">
                {project.group}
              </span>
            )}
          </div>
          {project.description && (
            <div className="truncate text-[11px] text-ink-faint">{project.description}</div>
          )}
        </div>

        <div className="ml-2 flex flex-wrap gap-1">
          {project.tags.map((t) => (
            <span
              key={t}
              className="rounded-md bg-accent-dim px-1.5 py-0.5 text-[10px] font-semibold text-accent-hover"
            >
              {t}
            </span>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
            onClick={() => setEditing(true)}
          >
            <Pencil size={14} /> Edit
          </button>
          <button
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-ink-soft hover:bg-bg-hover hover:text-bad"
            onClick={() => {
              if (confirm(`Delete project "${project.name}"?`)) deleteProject(project.id)
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </header>

      <div className="flex items-center gap-1 border-b border-line px-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13px] font-semibold transition-colors',
              tab === t.id
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-soft hover:text-ink'
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Panels stay mounted so SSH sessions and DB connections survive tab switches. */}
      <div className="min-h-0 flex-1">
        <div className={cn('h-full', tab === 'ssh' ? 'block' : 'hidden')}>
          <SshPanel project={project} />
        </div>
        <div className={cn('h-full', tab === 'repo' ? 'block' : 'hidden')}>
          <RepoPanel project={project} />
        </div>
        <div className={cn('h-full', tab === 'db' ? 'block' : 'hidden')}>
          <DbPanel project={project} />
        </div>
      </div>

      {editing && <ProjectDialog project={project} onClose={() => setEditing(false)} />}
    </div>
  )
}
