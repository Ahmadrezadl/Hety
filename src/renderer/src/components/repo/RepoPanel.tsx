import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode
} from 'react'
import {
  GitBranch,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  FolderOpen,
  FolderSearch,
  FolderGit2,
  ExternalLink,
  Tag,
  Search,
  ChevronDown,
  ChevronRight,
  Check,
  Plus,
  X,
  Download,
  Folder,
  TerminalSquare,
  GitCommitHorizontal,
  FileDiff,
  Copy,
  Pencil,
  Trash2,
  FolderTree
} from 'lucide-react'
import type {
  Project,
  Repository,
  GitStatus,
  GitFile,
  GitGraphCommit,
  MergeMode
} from '@shared/types'
import { useApp, newId } from '../../store'
import { basename } from '../../lib/projects'
import { Button, Spinner, Modal, Input, Field, cn } from '../../lib/ui'
import { toast } from '../../lib/toast'
import DiffView from './DiffView'

const CODE_COLOR: Record<string, string> = {
  M: '#e0b341',
  A: '#46c08a',
  D: '#e0625e',
  R: '#6d8cff',
  C: '#6d8cff',
  '?': '#46c08a'
}
const codeLetter = (c: string): string => (c === '?' ? 'U' : c[0] ?? 'M')

const EDITORS: { label: string; command: string }[] = [
  { label: 'Explorer', command: '' },
  { label: 'VS Code', command: 'code' },
  { label: 'Cursor', command: 'cursor' },
  { label: 'WebStorm', command: 'webstorm' },
  { label: 'Rider', command: 'rider' }
]

type TagTarget = { hash: string; message: string }

function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/')
  return i >= 0 ? { dir: p.slice(0, i), name: p.slice(i + 1) } : { dir: '', name: p }
}

// ============================================================================
// Outer panel: manages the project's repositories as tabs.
// ============================================================================
export default function RepoPanel({ project }: { project: Project }): ReactNode {
  const upsertProject = useApp((s) => s.upsertProject)
  const repositories = project.repositories ?? []
  const [activeId, setActiveId] = useState<string | null>(repositories[0]?.id ?? null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const active = repositories.find((r) => r.id === activeId) ?? repositories[0] ?? null

  const setRepos = (repos: Repository[]): void => upsertProject({ ...project, repositories: repos })

  const addRepoFromPath = (path: string, name: string): void => {
    const repo: Repository = { id: newId(), name: name || basename(path), path }
    setRepos([...repositories, repo])
    setActiveId(repo.id)
  }

  const pickExisting = async (): Promise<void> => {
    const p = await window.api.app.pickFolder()
    if (!p) return
    addRepoFromPath(p, basename(p))
    setAddOpen(false)
  }

  const cloneRepo = async (
    url: string,
    directory: string,
    name: string
  ): Promise<{ ok: boolean; error?: string }> => {
    const r = await window.api.git.clone(url, directory, name)
    if (r.ok && r.data) {
      addRepoFromPath(r.data, name)
      setAddOpen(false)
    }
    return r
  }

  const relocate = async (id: string): Promise<void> => {
    const p = await window.api.app.pickFolder()
    if (p) setRepos(repositories.map((r) => (r.id === id ? { ...r, path: p } : r)))
  }

  const removeRepo = (id: string): void => {
    const repo = repositories.find((r) => r.id === id)
    if (repo && !confirm(`Remove repository "${repo.name}" from this project? (the folder is not deleted)`))
      return
    const next = repositories.filter((r) => r.id !== id)
    setRepos(next)
    if (activeId === id) setActiveId(next[0]?.id ?? null)
  }

  const startRename = (repo: Repository): void => {
    setRenamingId(repo.id)
    setRenameValue(repo.name)
  }
  const commitRename = (): void => {
    if (renamingId) {
      const name = renameValue.trim()
      if (name) setRepos(repositories.map((r) => (r.id === renamingId ? { ...r, name } : r)))
    }
    setRenamingId(null)
  }

  const addDialog = addOpen ? (
    <AddRepoDialog onClose={() => setAddOpen(false)} onPickExisting={pickExisting} onClone={cloneRepo} />
  ) : null

  if (repositories.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FolderGit2 size={44} className="text-ink-faint" />
        <div className="text-[15px] font-semibold text-ink-soft">No repositories yet</div>
        <p className="max-w-sm text-xs text-ink-faint">
          This project has no Git repositories. Add one — or several, e.g. <em>client</em> and{' '}
          <em>backend</em> — to manage them here with tabs.
        </p>
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={16} /> Add repository
        </Button>
        {addDialog}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch overflow-x-auto border-b border-line bg-bg-panel">
        {repositories.map((r) => (
          <div
            key={r.id}
            onClick={() => setActiveId(r.id)}
            onDoubleClick={() => startRename(r)}
            title={r.path}
            className={cn(
              'group flex shrink-0 cursor-pointer items-center gap-2 border-r border-t-2 border-line px-3.5 py-2 text-[13px]',
              active?.id === r.id
                ? 'border-t-accent bg-bg-base text-ink'
                : 'border-t-transparent text-ink-soft hover:bg-bg-hover'
            )}
          >
            <GitBranch size={12} className="shrink-0" />
            {renamingId === r.id ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  else if (e.key === 'Escape') setRenamingId(null)
                }}
                className="w-24 rounded bg-bg-input px-1 text-[13px] outline-none ring-1 ring-accent"
              />
            ) : (
              <span className="max-w-[160px] truncate">{r.name}</span>
            )}
            <span
              className="rounded p-0.5 opacity-0 hover:bg-bg-hover hover:text-bad group-hover:opacity-100"
              title="Remove repository"
              onClick={(e) => {
                e.stopPropagation()
                removeRepo(r.id)
              }}
            >
              <X size={12} />
            </span>
          </div>
        ))}
        <button
          onClick={() => setAddOpen(true)}
          title="Add repository"
          className="flex shrink-0 items-center gap-1 px-3 text-ink-soft hover:bg-bg-hover hover:text-ink"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {active && (
          <RepoView key={active.id} path={active.path} onPickFolder={() => relocate(active.id)} />
        )}
      </div>
      {addDialog}
    </div>
  )
}

// ============================================================================
// Inner panel: Fork-style Git UI for a single repository.
// ============================================================================
function RepoView({ path, onPickFolder }: { path: string; onPickFolder: () => void }): ReactNode {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [graph, setGraph] = useState<GitGraphCommit[]>([])
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'changes' | 'commits'>('commits')
  const [filter, setFilter] = useState('')
  const [selHash, setSelHash] = useState<string | null>(null)
  const [tagFor, setTagFor] = useState<TagTarget | null>(null)
  const [mergeReq, setMergeReq] = useState<{ source: string; into: string } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; branch: string; remote: boolean } | null>(null)
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; commit: GitGraphCommit } | null>(null)
  const [checkoutCommit, setCheckoutCommit] = useState<GitGraphCommit | null>(null)
  const [prompt, setPrompt] = useState<{
    title: string
    label: string
    initial: string
    confirmLabel: string
    onSubmit: (v: string) => void
  } | null>(null)

  const refresh = useCallback(async () => {
    if (!path) return
    const [st, gr] = await Promise.all([window.api.git.status(path), window.api.git.graphLog(path)])
    if (st.ok && st.data) setStatus(st.data)
    if (gr.ok && gr.data) setGraph(gr.data)
  }, [path])

  useEffect(() => {
    refresh()
  }, [refresh])

  const run = async (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    okMsg?: string
  ): Promise<void> => {
    setBusy(true)
    const r = await fn()
    setBusy(false)
    if (!r.ok) toast.error(r.error ?? 'Failed')
    else if (okMsg) toast.success(okMsg)
    await refresh()
  }

  if (!path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FolderGit2 size={44} className="text-ink-faint" />
        <div className="text-[15px] font-semibold text-ink-soft">No repository folder set</div>
        <Button onClick={onPickFolder}>
          <FolderOpen size={16} /> Choose repository folder
        </Button>
      </div>
    )
  }

  if (status && !status.isRepo) {
    const missing = !status.exists
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FolderGit2 size={44} className="text-ink-faint" />
        <div className="text-[15px] font-semibold text-ink-soft">
          {missing ? 'Repository folder not found' : 'Not a Git repository'}
        </div>
        <div className="max-w-md break-all text-xs text-ink-faint">{path}</div>
        {missing && (
          <p className="max-w-sm text-xs text-ink-faint">
            The folder may have been moved or deleted. Your SSH servers and databases for this
            project are still saved — just point the repository to its new location.
          </p>
        )}
        <Button onClick={onPickFolder}>
          {missing ? (
            <>
              <FolderSearch size={16} /> Locate folder
            </>
          ) : (
            <>
              <FolderOpen size={16} /> Change folder
            </>
          )}
        </Button>
      </div>
    )
  }

  const changeCount = (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0)
  const selectedCommit = graph.find((c) => c.hash === selHash) ?? null

  const checkout = (branch: string): void => {
    run(() => window.api.git.checkout(path, branch), `Switched to ${branch}`)
  }
  const checkoutRemote = (ref: string): void => {
    run(() => window.api.git.checkoutRemote(path, ref), `Checked out ${ref}`)
  }

  const onMergeConfirm = (source: string, into: string, mode: MergeMode): void => {
    setMergeReq(null)
    run(() => window.api.git.merge(path, source, { into, mode }), `Merged ${source} into ${into}`)
  }

  const branchMenuItems = (branch: string, remote: boolean): MenuItem[] => {
    const items: MenuItem[] = []
    items.push({ label: 'Checkout', onClick: () => (remote ? checkoutRemote(branch) : checkout(branch)) })
    if (status && branch !== status.branch)
      items.push({
        label: `Merge into '${status.branch}'`,
        onClick: () => setMergeReq({ source: branch, into: status.branch })
      })
    if (!remote) {
      items.push({
        label: 'New branch from here…',
        onClick: () =>
          setPrompt({
            title: 'New branch',
            label: `Create a branch starting at '${branch}'`,
            initial: '',
            confirmLabel: 'Create',
            onSubmit: (v) => {
              setPrompt(null)
              run(async () => {
                const co = await window.api.git.checkout(path, branch)
                if (!co.ok) return co
                return window.api.git.createBranch(path, v, true)
              }, `Created ${v}`)
            }
          })
      })
      items.push({
        label: 'Rename…',
        onClick: () =>
          setPrompt({
            title: 'Rename branch',
            label: `New name for '${branch}'`,
            initial: branch,
            confirmLabel: 'Rename',
            onSubmit: (v) => {
              setPrompt(null)
              run(() => window.api.git.renameBranch(path, branch, v), `Renamed to ${v}`)
            }
          })
      })
      items.push({
        label: 'Delete…',
        danger: true,
        onClick: () => {
          if (confirm(`Delete branch '${branch}'?`))
            run(() => window.api.git.deleteBranch(path, branch), `Deleted ${branch}`)
        }
      })
    }
    items.push({ label: 'Copy name', onClick: () => navigator.clipboard.writeText(branch) })
    return items
  }

  const commitMenuItems = (c: GitGraphCommit): MenuItem[] => {
    const short = c.hash.slice(0, 7)
    return [
      {
        label: 'Checkout',
        onClick: () => run(() => window.api.git.checkout(path, c.hash), `Checked out ${short}`)
      },
      {
        label: 'New branch…',
        onClick: () =>
          setPrompt({
            title: 'New branch',
            label: `Create a branch at ${short}`,
            initial: '',
            confirmLabel: 'Create',
            onSubmit: (v) => {
              setPrompt(null)
              run(() => window.api.git.createBranch(path, v, true, c.hash), `Created ${v}`)
            }
          })
      },
      { label: 'New tag…', onClick: () => setTagFor({ hash: short, message: c.message }) },
      {
        label: 'Cherry-pick commit',
        onClick: () => run(() => window.api.git.cherryPick(path, c.hash), `Cherry-picked ${short}`)
      },
      {
        label: 'Revert commit',
        onClick: () => run(() => window.api.git.revert(path, c.hash), `Reverted ${short}`)
      }
    ]
  }

  return (
    <div className="flex h-full flex-col bg-bg-base" onClick={() => menu && setMenu(null)}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-line bg-bg-panel px-2 py-1.5">
        <ToolbarBtn
          icon={<RefreshCw size={15} />}
          label="Fetch"
          onClick={() => run(() => window.api.git.fetch(path), 'Fetched')}
        />
        <ToolbarBtn
          icon={<ArrowDown size={15} />}
          label="Pull"
          badge={status?.behind || undefined}
          onClick={() => run(() => window.api.git.pull(path), 'Pulled')}
        />
        <ToolbarBtn
          icon={<ArrowUp size={15} />}
          label="Push"
          badge={status?.ahead || undefined}
          onClick={() => run(() => window.api.git.push(path), 'Pushed')}
        />
        <div className="mx-1 h-5 w-px bg-line" />
        <span className="flex items-center gap-1.5 px-1 text-[12px] font-semibold text-ink">
          <GitBranch size={14} className="text-accent" />
          {status?.branch || 'detached HEAD'}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {busy && <Spinner className="mr-1" />}
          <ToolbarBtn
            icon={<TerminalSquare size={15} />}
            label="Console"
            onClick={() => window.api.app.openTerminal(path)}
          />
          <OpenInMenu path={path} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className="flex w-[230px] shrink-0 flex-col border-r border-line bg-bg-panel">
          <div className="p-2">
            <NavItem
              icon={<FileDiff size={14} />}
              label="Local Changes"
              count={changeCount}
              active={view === 'changes'}
              onClick={() => setView('changes')}
            />
            <NavItem
              icon={<GitCommitHorizontal size={14} />}
              label="All Commits"
              active={view === 'commits'}
              onClick={() => setView('commits')}
            />
          </div>
          <div className="px-2 pb-2">
            <div className="relative">
              <Search size={12} className="pointer-events-none absolute left-2 top-2 text-ink-faint" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter branches & tags…"
                className="w-full rounded-md bg-bg-input py-1.5 pl-7 pr-2 text-xs outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-accent"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-3">
            {status && (
              <BranchTree
                status={status}
                filter={filter}
                onCheckout={checkout}
                onCheckoutRemote={checkoutRemote}
                onMerge={(source, into) => setMergeReq({ source, into })}
                onContext={(e, branch, remote) =>
                  setMenu({ x: e.clientX, y: e.clientY, branch, remote })
                }
                onSelectTag={(hash) => {
                  setView('commits')
                  setSelHash(hash)
                }}
                graph={graph}
              />
            )}
          </div>
        </aside>

        {/* Main */}
        <div className="min-w-0 flex-1">
          {view === 'changes' ? (
            <LocalChangesView path={path} status={status} busy={busy} run={run} />
          ) : (
            <CommitsView
              path={path}
              commits={graph}
              selHash={selHash}
              onSelect={setSelHash}
              onDoubleSelect={setCheckoutCommit}
              onContext={(e, c) => setCommitMenu({ x: e.clientX, y: e.clientY, commit: c })}
              onTag={setTagFor}
              commit={selectedCommit}
            />
          )}
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={branchMenuItems(menu.branch, menu.remote)}
          onClose={() => setMenu(null)}
        />
      )}

      {commitMenu && (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          items={commitMenuItems(commitMenu.commit)}
          onClose={() => setCommitMenu(null)}
        />
      )}

      {checkoutCommit && (
        <Modal title="Checkout commit" width={440} onClose={() => setCheckoutCommit(null)}>
          <div className="space-y-3">
            <div className="rounded-md border border-line bg-bg-elevated px-3 py-2 text-[12px]">
              <span className="font-mono text-accent">{checkoutCommit.hash.slice(0, 7)}</span>{' '}
              <span className="text-ink-soft">{checkoutCommit.message}</span>
            </div>
            <p className="text-xs text-ink-faint">
              Checking out a specific commit puts the repository in a “detached HEAD” state. Create a
              branch from here if you want to keep new commits.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCheckoutCommit(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const h = checkoutCommit.hash
                  setCheckoutCommit(null)
                  run(() => window.api.git.checkout(path, h), `Checked out ${h.slice(0, 7)}`)
                }}
              >
                Checkout
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {mergeReq && status && (
        <MergeOptionsDialog
          source={mergeReq.source}
          into={mergeReq.into}
          onClose={() => setMergeReq(null)}
          onMerge={(mode) => onMergeConfirm(mergeReq.source, mergeReq.into, mode)}
        />
      )}

      {prompt && (
        <TextPromptModal
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          confirmLabel={prompt.confirmLabel}
          onClose={() => setPrompt(null)}
          onSubmit={prompt.onSubmit}
        />
      )}

      {tagFor && (
        <TagDialog
          commit={tagFor}
          onClose={() => setTagFor(null)}
          onCreate={(name, msg, push) => {
            const ref = tagFor.hash
            setTagFor(null)
            run(
              () => window.api.git.addTag(path, name, { ref, message: msg || undefined, push }),
              push ? `Created & pushed tag ${name}` : `Created tag ${name}`
            )
          }}
        />
      )}
    </div>
  )
}

// ---- Toolbar bits ----

function ToolbarBtn({
  icon,
  label,
  badge,
  onClick
}: {
  icon: ReactNode
  label: string
  badge?: number
  onClick: () => void
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
    >
      {icon}
      {label}
      {badge ? (
        <span className="ml-0.5 rounded-full bg-accent px-1.5 py-px text-[10px] font-bold leading-none text-white">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

function OpenInMenu({ path }: { path: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
      >
        <ExternalLink size={15} /> Open in
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-lg border border-line bg-bg-panel py-1 shadow-xl">
            {EDITORS.map((ed) => (
              <button
                key={ed.label}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover"
                onClick={() => {
                  setOpen(false)
                  if (ed.command) window.api.app.openEditor(ed.command, path)
                  else window.api.app.openPath(path)
                }}
              >
                {ed.label === 'Explorer' ? <FolderOpen size={13} /> : <ExternalLink size={13} />}
                {ed.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function NavItem({
  icon,
  label,
  count,
  active,
  onClick
}: {
  icon: ReactNode
  label: string
  count?: number
  active: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cn(
        'mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-semibold',
        active ? 'bg-accent-dim text-ink' : 'text-ink-soft hover:bg-bg-hover hover:text-ink'
      )}
    >
      <span className={active ? 'text-accent' : 'text-ink-faint'}>{icon}</span>
      <span className="flex-1">{label}</span>
      {count ? <span className="text-[11px] text-ink-faint">{count}</span> : null}
    </button>
  )
}

// ---- Branch / tags tree ----

function BranchTree({
  status,
  filter,
  onCheckout,
  onCheckoutRemote,
  onMerge,
  onContext,
  onSelectTag,
  graph
}: {
  status: GitStatus
  filter: string
  onCheckout: (b: string) => void
  onCheckoutRemote: (b: string) => void
  onMerge: (source: string, into: string) => void
  onContext: (e: MouseEvent, branch: string, remote: boolean) => void
  onSelectTag: (hash: string) => void
  graph: GitGraphCommit[]
}): ReactNode {
  const dragRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [open, setOpen] = useState({ branches: true, remotes: true, tags: false })

  const ql = filter.toLowerCase().trim()
  const match = (s: string): boolean => !ql || s.toLowerCase().includes(ql)
  const locals = status.branches.filter(match)
  const remotes = status.remoteBranches.filter((b) => !b.includes('->')).filter(match)
  const tags = status.tags.filter(match)

  const tagHash = (t: string): string | undefined =>
    graph.find((c) => c.refs.some((r) => r === `tag: ${t}`))?.hash

  const branchRow = (b: string, remote: boolean): ReactNode => {
    const current = !remote && b === status.branch
    return (
      <div
        key={(remote ? 'r:' : 'l:') + b}
        draggable
        onDragStart={(e) => {
          dragRef.current = b
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', b)
        }}
        onDragOver={
          remote
            ? undefined
            : (e) => {
                e.preventDefault()
                if (dragRef.current && dragRef.current !== b) setDropTarget(b)
              }
        }
        onDragLeave={remote ? undefined : () => setDropTarget((t) => (t === b ? null : t))}
        onDrop={
          remote
            ? undefined
            : (e) => {
                e.preventDefault()
                const src = dragRef.current
                dragRef.current = null
                setDropTarget(null)
                if (src && src !== b) onMerge(src, b)
              }
        }
        onDoubleClick={() => (remote ? onCheckoutRemote(b) : onCheckout(b))}
        onContextMenu={(e) => {
          e.preventDefault()
          onContext(e, b, remote)
        }}
        title={remote ? `${b} — double-click to check out` : `${b} — double-click to check out, drag onto another branch to merge`}
        className={cn(
          'group flex cursor-pointer items-center gap-1.5 rounded-md py-[3px] pl-6 pr-2 text-[12px]',
          dropTarget === b
            ? 'bg-accent/20 ring-1 ring-accent'
            : current
              ? 'bg-accent-dim text-ink'
              : 'text-ink-soft hover:bg-bg-hover hover:text-ink'
        )}
      >
        {current ? (
          <Check size={12} className="shrink-0 text-accent" />
        ) : (
          <GitBranch size={12} className={cn('shrink-0', remote ? 'text-ink-faint/60' : 'text-ink-faint')} />
        )}
        <span className={cn('min-w-0 flex-1 truncate', current && 'font-bold')}>{b}</span>
      </div>
    )
  }

  return (
    <div className="select-none text-[13px]">
      <TreeSection
        label="Branches"
        count={status.branches.length}
        open={open.branches}
        onToggle={() => setOpen((o) => ({ ...o, branches: !o.branches }))}
      >
        {locals.length ? locals.map((b) => branchRow(b, false)) : <Empty />}
      </TreeSection>

      <TreeSection
        label="Remotes"
        count={remotes.length}
        open={open.remotes}
        onToggle={() => setOpen((o) => ({ ...o, remotes: !o.remotes }))}
      >
        {remotes.length ? remotes.map((b) => branchRow(b, true)) : <Empty />}
      </TreeSection>

      <TreeSection
        label="Tags"
        count={status.tags.length}
        open={open.tags}
        onToggle={() => setOpen((o) => ({ ...o, tags: !o.tags }))}
      >
        {tags.length ? (
          tags.map((t) => {
            const h = tagHash(t)
            return (
              <div
                key={t}
                onClick={() => h && onSelectTag(h)}
                className="flex cursor-pointer items-center gap-1.5 rounded-md py-[3px] pl-6 pr-2 text-[12px] text-ink-soft hover:bg-bg-hover hover:text-ink"
              >
                <Tag size={12} className="shrink-0 text-warn" />
                <span className="min-w-0 flex-1 truncate">{t}</span>
              </div>
            )
          })
        ) : (
          <Empty />
        )}
      </TreeSection>
    </div>
  )
}

function TreeSection({
  label,
  count,
  open,
  onToggle,
  children
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}): ReactNode {
  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-ink-faint hover:text-ink-soft"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
        <span className="ml-auto font-medium normal-case">{count}</span>
      </button>
      {open && <div className="px-2">{children}</div>}
    </div>
  )
}

function Empty(): ReactNode {
  return <div className="px-6 py-1 text-[11px] text-ink-faint">None</div>
}

// ---- Local Changes view ----

function LocalChangesView({
  path,
  status,
  busy,
  run
}: {
  path: string
  status: GitStatus | null
  busy: boolean
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) => Promise<void>
}): ReactNode {
  const [sel, setSel] = useState<{ file: string; staged: boolean; untracked: boolean } | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const unstaged = status?.unstaged ?? []
  const staged = status?.staged ?? []

  // Keep the current selection valid as files change.
  useEffect(() => {
    if (!sel) return
    const list = sel.staged ? staged : unstaged
    if (!list.some((f) => f.path === sel.file)) setSel(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  useEffect(() => {
    if (!sel) {
      setDiff(null)
      return
    }
    let cancel = false
    setLoading(true)
    window.api.git
      .diff(path, { file: sel.file, staged: sel.staged, untracked: sel.untracked })
      .then((r) => {
        if (cancel) return
        setLoading(false)
        setDiff(r.ok ? r.data ?? '' : `Error: ${r.error}`)
      })
    return () => {
      cancel = true
    }
  }, [path, sel])

  const doCommit = (push: boolean): void => {
    const msg = message.trim()
    if (!msg) return
    run(async () => {
      const c = await window.api.git.commit(path, msg)
      if (!c.ok) return c
      if (push) {
        const p = await window.api.git.push(path)
        if (!p.ok) return p
      }
      setMessage('')
      return { ok: true }
    }, push ? 'Committed & pushed' : 'Committed')
  }

  return (
    <div className="flex h-full">
      {/* lists + commit box */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-line">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ChangeList
            title="Unstaged"
            files={unstaged}
            actionLabel="Stage"
            onAction={(files) => run(() => window.api.git.stage(path, files))}
            onAll={unstaged.length ? () => run(() => window.api.git.stageAll(path)) : undefined}
            allLabel="Stage all"
            secondaryLabel="Discard"
            onSecondary={(files) =>
              confirm(`Discard changes to ${files.join(', ')}?`) &&
              run(() => window.api.git.discard(path, files))
            }
            selectedFile={sel && !sel.staged ? sel.file : null}
            onSelect={(f) => setSel({ file: f.path, staged: false, untracked: f.code === '?' })}
          />
          <ChangeList
            title="Staged"
            files={staged}
            actionLabel="Unstage"
            onAction={(files) => run(() => window.api.git.unstage(path, files))}
            onAll={staged.length ? () => run(() => window.api.git.unstageAll(path)) : undefined}
            allLabel="Unstage all"
            selectedFile={sel && sel.staged ? sel.file : null}
            onSelect={(f) => setSel({ file: f.path, staged: true, untracked: false })}
          />
        </div>
        <div className="border-t border-line p-2.5">
          <input
            className="field-input mb-1.5"
            placeholder="Commit subject"
            value={message.split('\n')[0]}
            onChange={(e) => {
              const rest = message.includes('\n') ? '\n' + message.split('\n').slice(1).join('\n') : ''
              setMessage(e.target.value + rest)
            }}
          />
          <textarea
            className="field-input mb-2 min-h-[44px] resize-none text-[12px]"
            placeholder="Description"
            value={message.includes('\n') ? message.split('\n').slice(1).join('\n') : ''}
            onChange={(e) => setMessage(message.split('\n')[0] + '\n' + e.target.value)}
          />
          <div className="flex gap-2">
            <Button className="flex-1" disabled={!message.trim() || !staged.length || busy} onClick={() => doCommit(false)}>
              Commit
            </Button>
            <Button
              variant="ghost"
              className="flex-1"
              disabled={!message.trim() || !staged.length || busy}
              onClick={() => doCommit(true)}
            >
              Commit & Push
            </Button>
          </div>
        </div>
      </div>

      {/* diff */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="truncate border-b border-line bg-bg-panel px-3 py-1.5 font-mono text-[11px] text-ink-soft">
          {sel ? sel.file : 'No file selected'}
        </div>
        <div className="min-h-0 flex-1">
          <DiffView diff={diff} loading={loading} empty="Select a changed file to view its diff." />
        </div>
      </div>
    </div>
  )
}

function ChangeList({
  title,
  files,
  actionLabel,
  onAction,
  onAll,
  allLabel,
  secondaryLabel,
  onSecondary,
  selectedFile,
  onSelect
}: {
  title: string
  files: GitFile[]
  actionLabel: string
  onAction: (files: string[]) => void
  onAll?: () => void
  allLabel: string
  secondaryLabel?: string
  onSecondary?: (files: string[]) => void
  selectedFile: string | null
  onSelect: (f: GitFile) => void
}): ReactNode {
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center justify-between bg-bg-panel px-3 py-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">
          {title} {files.length > 0 && <span className="text-ink-soft">({files.length})</span>}
        </span>
        {onAll && (
          <button className="text-[11px] font-semibold text-accent hover:text-accent-hover" onClick={onAll}>
            {allLabel}
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <div className="px-3 pb-2 text-[11px] text-ink-faint">Nothing here.</div>
      ) : (
        files.map((f) => {
          const { dir, name } = splitPath(f.path)
          return (
            <div
              key={f.path}
              onClick={() => onSelect(f)}
              className={cn(
                'group flex cursor-pointer items-center gap-2 px-3 py-1',
                selectedFile === f.path ? 'bg-accent-dim' : 'hover:bg-bg-hover'
              )}
            >
              <span
                className="w-3 shrink-0 text-center font-mono text-xs font-bold"
                style={{ color: CODE_COLOR[f.code] ?? '#9aa1ad' }}
              >
                {codeLetter(f.code)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                {name}
                {dir && <span className="text-ink-faint"> · {dir}</span>}
              </span>
              <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
                {secondaryLabel && onSecondary && (
                  <button
                    className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft hover:bg-bg-hover hover:text-bad"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSecondary([f.path])
                    }}
                  >
                    {secondaryLabel}
                  </button>
                )}
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-accent hover:bg-bg-hover"
                  onClick={(e) => {
                    e.stopPropagation()
                    onAction([f.path])
                  }}
                >
                  {actionLabel}
                </button>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

// ---- All Commits view ----

function CommitsView({
  path,
  commits,
  selHash,
  onSelect,
  onDoubleSelect,
  onContext,
  onTag,
  commit
}: {
  path: string
  commits: GitGraphCommit[]
  selHash: string | null
  onSelect: (hash: string) => void
  onDoubleSelect: (c: GitGraphCommit) => void
  onContext: (e: MouseEvent, c: GitGraphCommit) => void
  onTag: (c: TagTarget) => void
  commit: GitGraphCommit | null
}): ReactNode {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-[1_1_56%] overflow-auto border-b border-line">
        <GraphView
          commits={commits}
          selectedHash={selHash}
          onSelect={onSelect}
          onDoubleSelect={onDoubleSelect}
          onContext={onContext}
          onTag={onTag}
        />
      </div>
      <div className="min-h-0 flex-[1_1_44%]">
        <CommitDetail path={path} commit={commit} />
      </div>
    </div>
  )
}

function CommitDetail({ path, commit }: { path: string; commit: GitGraphCommit | null }): ReactNode {
  const [tab, setTab] = useState<'commit' | 'changes' | 'tree'>('changes')
  const [files, setFiles] = useState<GitFile[]>([])
  const [selFile, setSelFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const hash = commit?.hash

  useEffect(() => {
    setFiles([])
    setSelFile(null)
    setDiff(null)
    if (!hash) return
    let cancel = false
    window.api.git.commitFiles(path, hash).then((r) => {
      if (cancel) return
      if (r.ok && r.data) {
        setFiles(r.data)
        setSelFile(r.data[0]?.path ?? null)
      }
    })
    return () => {
      cancel = true
    }
  }, [path, hash])

  useEffect(() => {
    if (!hash || !selFile) {
      setDiff(null)
      return
    }
    let cancel = false
    setLoading(true)
    window.api.git.diff(path, { hash, file: selFile }).then((r) => {
      if (cancel) return
      setLoading(false)
      setDiff(r.ok ? r.data ?? '' : `Error: ${r.error}`)
    })
    return () => {
      cancel = true
    }
  }, [path, hash, selFile])

  if (!commit)
    return (
      <div className="flex h-full items-center justify-center text-xs text-ink-faint">
        Select a commit to see its details.
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2">
        <DetailTab id="commit" active={tab} onClick={setTab}>
          Commit
        </DetailTab>
        <DetailTab id="changes" active={tab} onClick={setTab}>
          Changes ({files.length})
        </DetailTab>
        <DetailTab id="tree" active={tab} onClick={setTab}>
          File Tree
        </DetailTab>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'commit' ? (
          <CommitMeta commit={commit} />
        ) : (
          <div className="flex h-full">
            <div className="w-[280px] shrink-0 overflow-y-auto border-r border-line">
              {tab === 'changes' ? (
                <FlatFiles files={files} selFile={selFile} onSelect={setSelFile} />
              ) : (
                <TreeFiles files={files} selFile={selFile} onSelect={setSelFile} />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="truncate border-b border-line bg-bg-panel px-3 py-1.5 font-mono text-[11px] text-ink-soft">
                {selFile ?? '—'}
              </div>
              <div className="min-h-0 flex-1">
                <DiffView diff={diff} loading={loading} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DetailTab({
  id,
  active,
  onClick,
  children
}: {
  id: 'commit' | 'changes' | 'tree'
  active: string
  onClick: (id: 'commit' | 'changes' | 'tree') => void
  children: ReactNode
}): ReactNode {
  return (
    <button
      onClick={() => onClick(id)}
      className={cn(
        'border-b-2 px-3 py-2 text-[12px] font-semibold transition-colors',
        active === id ? 'border-accent text-ink' : 'border-transparent text-ink-soft hover:text-ink'
      )}
    >
      {children}
    </button>
  )
}

function CommitMeta({ commit }: { commit: GitGraphCommit }): ReactNode {
  return (
    <div className="h-full overflow-y-auto p-4 text-[12px]">
      <div className="mb-3 text-[15px] font-semibold">{commit.message}</div>
      {commit.body && (
        <pre className="mb-3 whitespace-pre-wrap font-mono text-[12px] text-ink-soft">{commit.body}</pre>
      )}
      <dl className="space-y-1.5">
        <Meta label="Author">
          {commit.author} {commit.email && <span className="text-ink-faint">&lt;{commit.email}&gt;</span>}
        </Meta>
        <Meta label="Date">
          {commit.date ? new Date(commit.date).toLocaleString() : '—'}{' '}
          <span className="text-ink-faint">({commit.relative})</span>
        </Meta>
        <Meta label="SHA">
          <span className="font-mono text-accent">{commit.hash}</span>
        </Meta>
        <Meta label="Parents">
          {commit.parents.length ? (
            <span className="font-mono text-ink-soft">{commit.parents.map((p) => p.slice(0, 7)).join('  ')}</span>
          ) : (
            <span className="text-ink-faint">(root commit)</span>
          )}
        </Meta>
        {commit.refs.length > 0 && (
          <Meta label="Refs">
            <span className="flex flex-wrap gap-1">
              {commit.refs.map((r) => (
                <RefChip key={r} name={r} />
              ))}
            </span>
          </Meta>
        )}
      </dl>
    </div>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-[11px] font-bold uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  )
}

function FlatFiles({
  files,
  selFile,
  onSelect
}: {
  files: GitFile[]
  selFile: string | null
  onSelect: (f: string) => void
}): ReactNode {
  if (files.length === 0) return <div className="p-3 text-xs text-ink-faint">No file changes.</div>
  return (
    <div className="py-1">
      {files.map((f) => {
        const { dir, name } = splitPath(f.path)
        return (
          <button
            key={f.path}
            onClick={() => onSelect(f.path)}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1 text-left',
              selFile === f.path ? 'bg-accent-dim' : 'hover:bg-bg-hover'
            )}
          >
            <span
              className="w-3 shrink-0 text-center font-mono text-xs font-bold"
              style={{ color: CODE_COLOR[f.code] ?? '#9aa1ad' }}
            >
              {codeLetter(f.code)}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
              {name}
              {dir && <span className="text-ink-faint"> · {dir}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function TreeFiles({
  files,
  selFile,
  onSelect
}: {
  files: GitFile[]
  selFile: string | null
  onSelect: (f: string) => void
}): ReactNode {
  const groups = useMemo(() => {
    const map = new Map<string, GitFile[]>()
    for (const f of files) {
      const { dir } = splitPath(f.path)
      const key = dir || '.'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(f)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [files])

  if (files.length === 0) return <div className="p-3 text-xs text-ink-faint">No file changes.</div>
  return (
    <div className="py-1 text-[12px]">
      {groups.map(([dir, list]) => (
        <div key={dir} className="mb-1">
          <div className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold text-ink-faint">
            <FolderTree size={12} />
            <span className="truncate" title={dir}>
              {dir}
            </span>
          </div>
          {list.map((f) => {
            const { name } = splitPath(f.path)
            return (
              <button
                key={f.path}
                onClick={() => onSelect(f.path)}
                className={cn(
                  'flex w-full items-center gap-2 py-1 pl-7 pr-3 text-left',
                  selFile === f.path ? 'bg-accent-dim' : 'hover:bg-bg-hover'
                )}
              >
                <span
                  className="w-3 shrink-0 text-center font-mono text-xs font-bold"
                  style={{ color: CODE_COLOR[f.code] ?? '#9aa1ad' }}
                >
                  {codeLetter(f.code)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                  {name}
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// ---- Context menu ----

interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}
function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): ReactNode {
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="fixed z-50 min-w-[200px] overflow-hidden rounded-lg border border-line bg-bg-panel py-1 shadow-2xl"
        style={{ left: x, top: y }}
      >
        {items.map((it) => (
          <button
            key={it.label}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover',
              it.danger && 'text-bad'
            )}
            onClick={() => {
              it.onClick()
              onClose()
            }}
          >
            {it.label === 'Copy name' && <Copy size={12} />}
            {it.label === 'Rename…' && <Pencil size={12} />}
            {it.label === 'Delete…' && <Trash2 size={12} />}
            {it.label}
          </button>
        ))}
      </div>
    </>
  )
}

// ---- Merge options dialog (drag-drop result) ----

const MERGE_MODES: { id: MergeMode; label: string; desc: string; flag?: string }[] = [
  { id: 'default', label: 'Default', desc: 'Fast-forward if possible' },
  { id: 'no-ff', label: 'No Fast-Forward', desc: 'Always create a merge commit', flag: '--no-ff' },
  { id: 'squash', label: 'Squash', desc: 'Squash merge', flag: '--squash' },
  { id: 'no-commit', label: "Don't Commit", desc: 'Merge without commit', flag: '--no-commit' }
]

function MergeOptionsDialog({
  source,
  into,
  onClose,
  onMerge
}: {
  source: string
  into: string
  onClose: () => void
  onMerge: (mode: MergeMode) => void
}): ReactNode {
  const [mode, setMode] = useState<MergeMode>('default')
  return (
    <Modal title="Merge Branch" width={460} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-ink-faint">Merge one branch into another.</p>
        <div className="space-y-1.5 text-[13px]">
          <div className="flex items-center gap-2">
            <span className="w-12 text-ink-faint">Merge</span>
            <GitBranch size={13} className="text-accent" />
            <span className="font-semibold">{source}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 text-ink-faint">Into</span>
            <GitBranch size={13} className="text-accent" />
            <span className="font-semibold">{into}</span>
          </div>
        </div>
        <Field label="Merge option">
          <select className="field-input" value={mode} onChange={(e) => setMode(e.target.value as MergeMode)}>
            {MERGE_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.desc}
                {m.flag ? `  (${m.flag})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onMerge(mode)}>Merge</Button>
        </div>
      </div>
    </Modal>
  )
}

function TextPromptModal({
  title,
  label,
  initial,
  confirmLabel,
  onClose,
  onSubmit
}: {
  title: string
  label: string
  initial: string
  confirmLabel: string
  onClose: () => void
  onSubmit: (v: string) => void
}): ReactNode {
  const [v, setV] = useState(initial)
  return (
    <Modal title={title} width={420} onClose={onClose}>
      <div className="space-y-3">
        <Field label={label}>
          <Input
            autoFocus
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && v.trim()) onSubmit(v.trim())
            }}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!v.trim()} onClick={() => onSubmit(v.trim())}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ============================================================================
// Add repository dialog (existing folder vs clone).
// ============================================================================
function deriveRepoName(url: string): string {
  const cleaned = url.trim().replace(/\.git$/i, '').replace(/[/\\]+$/, '')
  return cleaned.split(/[/:\\]/).filter(Boolean).pop() ?? ''
}

function AddRepoDialog({
  onClose,
  onPickExisting,
  onClone
}: {
  onClose: () => void
  onPickExisting: () => void
  onClone: (url: string, directory: string, name: string) => Promise<{ ok: boolean; error?: string }>
}): ReactNode {
  const [mode, setMode] = useState<'choose' | 'clone'>('choose')
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [directory, setDirectory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onUrlChange = (v: string): void => {
    setUrl(v)
    if (!nameTouched) setName(deriveRepoName(v))
  }
  const browse = async (): Promise<void> => {
    const p = await window.api.app.pickFolder()
    if (p) setDirectory(p)
  }

  const sep = directory.includes('\\') ? '\\' : '/'
  const targetPreview = directory ? `${directory.replace(/[\\/]+$/, '')}${sep}${name}` : ''
  const canClone = !!url.trim() && !!name.trim() && !!directory.trim() && !busy

  const doClone = async (): Promise<void> => {
    if (!canClone) return
    setBusy(true)
    setError(null)
    const r = await onClone(url.trim(), directory.trim(), name.trim())
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'Clone failed.')
  }

  return (
    <Modal
      title={mode === 'choose' ? 'Add repository' : 'Clone repository'}
      width={mode === 'choose' ? 440 : 500}
      onClose={onClose}
    >
      {mode === 'choose' ? (
        <div className="space-y-2.5">
          <button
            onClick={onPickExisting}
            className="flex w-full items-center gap-3 rounded-lg border border-line bg-bg-panel p-3.5 text-left hover:border-accent hover:bg-bg-elevated"
          >
            <FolderOpen size={20} className="shrink-0 text-accent" />
            <span>
              <span className="block text-[13px] font-semibold">Open existing folder</span>
              <span className="block text-[11px] text-ink-faint">
                Use a Git repository already on your computer.
              </span>
            </span>
          </button>
          <button
            onClick={() => setMode('clone')}
            className="flex w-full items-center gap-3 rounded-lg border border-line bg-bg-panel p-3.5 text-left hover:border-accent hover:bg-bg-elevated"
          >
            <Download size={20} className="shrink-0 text-accent" />
            <span>
              <span className="block text-[13px] font-semibold">Clone repository</span>
              <span className="block text-[11px] text-ink-faint">
                Clone from an SSH or HTTPS URL into a new folder.
              </span>
            </span>
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Repository URL">
            <Input
              autoFocus
              placeholder="git@github.com:user/repo.git  or  https://github.com/user/repo.git"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
            />
          </Field>
          <Field label="Name" hint="Folder name and tab label for this repository.">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameTouched(true)
              }}
              placeholder="repo"
            />
          </Field>
          <Field
            label="Clone into"
            hint={targetPreview ? `Will create ${targetPreview}` : 'Pick the parent folder.'}
          >
            <div className="flex gap-2">
              <Input
                placeholder="C:\path\to\parent"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
              />
              <button onClick={browse} className="btn-ghost btn shrink-0 px-2" title="Browse" type="button">
                <Folder size={15} />
              </button>
            </div>
          </Field>

          {error && (
            <div className="break-all rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">{error}</div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button variant="ghost" onClick={() => setMode('choose')} disabled={busy}>
              Back
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button disabled={!canClone} onClick={doClone}>
                {busy ? (
                  <>
                    <Spinner /> Cloning…
                  </>
                ) : (
                  <>
                    <Download size={14} /> Clone
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function TagDialog({
  commit,
  onClose,
  onCreate
}: {
  commit: TagTarget
  onClose: () => void
  onCreate: (name: string, message: string, push: boolean) => void
}): ReactNode {
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')
  const [push, setPush] = useState(false)
  return (
    <Modal title="Create tag" width={440} onClose={onClose}>
      <div className="space-y-3">
        <div className="rounded-md border border-line bg-bg-elevated px-3 py-2 text-[11px]">
          <span className="font-mono text-accent">{commit.hash}</span>{' '}
          <span className="text-ink-soft">{commit.message}</span>
        </div>
        <Field label="Tag name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="v1.0.0"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) onCreate(name.trim(), msg.trim(), push)
            }}
          />
        </Field>
        <Field label="Message" hint="Leave empty for a lightweight tag.">
          <Input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Release notes…" />
        </Field>
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
          Push tag to origin
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} onClick={() => onCreate(name.trim(), msg.trim(), push)}>
            <Tag size={14} /> Create tag
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---- Branch graph (commit list) ----

const LANE_COLORS = ['#6d8cff', '#46c08a', '#e0b341', '#b07ee6', '#e0625e', '#56c7d6', '#e0883c', '#9aa1ad']
const ROW_H = 30
const LANE_W = 14
const PAD_X = 14
const NODE_R = 4

const colX = (i: number): number => PAD_X + i * LANE_W
const laneColor = (i: number): string =>
  LANE_COLORS[((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]

interface Seg {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
}
interface GraphRow {
  commit: GitGraphCommit
  col: number
  cx: number
  cy: number
  color: string
}

function buildGraph(commits: GitGraphCommit[]): {
  rows: GraphRow[]
  segments: Seg[]
  width: number
  height: number
} {
  const lanes: (string | null)[] = []
  const segments: Seg[] = []
  let maxCols = 1
  const line = (x1: number, y1: number, x2: number, y2: number, colorIdx: number): void => {
    segments.push({ x1, y1, x2, y2, color: laneColor(colorIdx) })
  }
  const rows: GraphRow[] = commits.map((c, r) => {
    const yTop = r * ROW_H
    const yMid = yTop + ROW_H / 2
    const yBot = yTop + ROW_H
    const before = lanes.slice()

    let col = lanes.indexOf(c.hash)
    if (col === -1) {
      col = lanes.indexOf(null)
      if (col === -1) {
        col = lanes.length
        lanes.push(null)
      }
    }

    const incoming: number[] = []
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) incoming.push(i)
    for (const i of incoming) lanes[i] = null

    const parentCols: number[] = []
    c.parents.forEach((p, idx) => {
      if (idx === 0) {
        lanes[col] = p
        parentCols.push(col)
      } else {
        let k = lanes.indexOf(p)
        if (k === -1) {
          k = lanes.indexOf(null)
          if (k === -1) {
            k = lanes.length
            lanes.push(null)
          }
          lanes[k] = p
        }
        parentCols.push(k)
      }
    })
    if (c.parents.length === 0) lanes[col] = null

    const after = lanes.slice()
    maxCols = Math.max(maxCols, before.length, after.length)

    const n = Math.max(before.length, after.length)
    for (let i = 0; i < n; i++) {
      if (before[i] != null && after[i] === before[i]) line(colX(i), yTop, colX(i), yBot, i)
    }
    if (before[col] === c.hash) line(colX(col), yTop, colX(col), yMid, col)
    for (const m of incoming) if (m !== col) line(colX(m), yTop, colX(col), yMid, m)
    parentCols.forEach((pc) => line(colX(col), yMid, colX(pc), yBot, pc))

    return { commit: c, col, cx: colX(col), cy: yMid, color: laneColor(col) }
  })

  const width = PAD_X + maxCols * LANE_W
  return { rows, segments, width, height: commits.length * ROW_H }
}

function RefChip({ name }: { name: string }): ReactNode {
  const isTag = name.startsWith('tag: ')
  const label = isTag ? name.slice(5) : name
  const remote = !isTag && name.includes('/')
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9px] font-bold',
        isTag ? 'bg-warn/15 text-warn' : remote ? 'bg-bg-elevated text-ink-faint' : 'bg-accent-dim text-accent-hover'
      )}
      title={name}
    >
      {isTag ? <Tag size={9} /> : <GitBranch size={9} />}
      {label}
    </span>
  )
}

function GraphView({
  commits,
  selectedHash,
  onSelect,
  onDoubleSelect,
  onContext,
  onTag
}: {
  commits: GitGraphCommit[]
  selectedHash: string | null
  onSelect: (hash: string) => void
  onDoubleSelect: (c: GitGraphCommit) => void
  onContext: (e: MouseEvent, c: GitGraphCommit) => void
  onTag: (c: TagTarget) => void
}): ReactNode {
  const { rows, segments, width, height } = useMemo(() => buildGraph(commits), [commits])
  if (commits.length === 0) return <div className="p-4 text-xs text-ink-faint">No commits to show.</div>
  return (
    <div className="flex text-[12px]" style={{ minHeight: height }}>
      <svg width={width} height={height} className="shrink-0">
        {segments.map((s, i) => (
          <line
            key={i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={s.color}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        ))}
        {rows.map((row, i) => (
          <circle key={i} cx={row.cx} cy={row.cy} r={NODE_R} fill={row.color} stroke="#0e0f13" strokeWidth={1.5} />
        ))}
      </svg>
      <div className="min-w-0 flex-1">
        {rows.map((row, i) => {
          const short = row.commit.hash.slice(0, 7)
          const selected = row.commit.hash === selectedHash
          return (
            <div
              key={i}
              style={{ height: ROW_H }}
              onClick={() => onSelect(row.commit.hash)}
              onDoubleClick={() => onDoubleSelect(row.commit)}
              onContextMenu={(e) => {
                e.preventDefault()
                onSelect(row.commit.hash)
                onContext(e, row.commit)
              }}
              className={cn(
                'group flex cursor-pointer items-center gap-1.5 px-2',
                selected ? 'bg-accent-dim' : 'hover:bg-bg-hover/40'
              )}
            >
              {row.commit.refs.map((r) => (
                <RefChip key={r} name={r} />
              ))}
              <span className="min-w-0 flex-1 truncate" title={row.commit.message}>
                {row.commit.message}
              </span>
              <button
                title="Tag this commit"
                onClick={(e) => {
                  e.stopPropagation()
                  onTag({ hash: short, message: row.commit.message })
                }}
                className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:text-accent group-hover:opacity-100"
              >
                <Tag size={12} />
              </button>
              <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                {short} · {row.commit.author} · {row.commit.relative}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
