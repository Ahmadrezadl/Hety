import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  GitBranch,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  FolderOpen,
  FolderSearch,
  FolderGit2,
  ExternalLink,
  GitMerge,
  Tag,
  Search,
  ChevronDown,
  Check,
  Network,
  List
} from 'lucide-react'
import type { Project, GitStatus, GitCommit, GitFile, GitGraphCommit } from '@shared/types'
import { useApp } from '../../store'
import { Button, Spinner, Modal, Input, Field, cn } from '../../lib/ui'

const CODE_COLOR: Record<string, string> = {
  M: '#e0b341',
  A: '#46c08a',
  D: '#e0625e',
  R: '#6d8cff',
  '?': '#46c08a'
}

const EDITORS: { label: string; command: string }[] = [
  { label: 'Explorer', command: '' },
  { label: 'VS Code', command: 'code' },
  { label: 'Cursor', command: 'cursor' },
  { label: 'WebStorm', command: 'webstorm' },
  { label: 'Rider', command: 'rider' }
]

type HistTab = 'commits' | 'graph'
type TagTarget = { hash: string; message: string }

export default function RepoPanel({ project }: { project: Project }): ReactNode {
  const upsertProject = useApp((s) => s.upsertProject)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitCommit[]>([])
  const [graph, setGraph] = useState<GitGraphCommit[]>([])
  const [message, setMessage] = useState('')
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [histTab, setHistTab] = useState<HistTab>('commits')
  const [mergeOpen, setMergeOpen] = useState(false)
  const [tagFor, setTagFor] = useState<TagTarget | null>(null)

  const path = project.repoPath

  const refresh = useCallback(async () => {
    if (!path) return
    const [st, lg, gr] = await Promise.all([
      window.api.git.status(path),
      window.api.git.log(path),
      window.api.git.graphLog(path)
    ])
    if (st.ok && st.data) setStatus(st.data)
    if (lg.ok && lg.data) setLog(lg.data)
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
    setNote(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setNote({ text: r.error ?? 'Failed', bad: true })
    else if (okMsg) setNote({ text: okMsg })
    await refresh()
  }

  const pickFolder = async (): Promise<void> => {
    const p = await window.api.app.pickFolder()
    if (p) upsertProject({ ...project, repoPath: p })
  }

  if (!path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FolderGit2 size={44} className="text-ink-faint" />
        <div className="text-[15px] font-semibold text-ink-soft">No repository folder set</div>
        <Button onClick={pickFolder}>
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
        <Button onClick={pickFolder}>
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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-line bg-bg-panel px-4 py-2.5">
        <GitBranch size={15} className="text-accent" />
        {status && (
          <BranchPicker
            status={status}
            onPick={(value, isLocal) =>
              isLocal
                ? run(() => window.api.git.checkout(path, value), `Switched to ${value}`)
                : run(() => window.api.git.checkoutRemote(path, value), `Checked out ${value}`)
            }
          />
        )}
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="flex items-center gap-2 text-xs text-ink-soft">
            {status.ahead > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowUp size={12} />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowDown size={12} />
                {status.behind}
              </span>
            )}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {busy && <Spinner />}
          <Button size="sm" variant="ghost" onClick={() => run(() => window.api.git.fetch(path), 'Fetched')}>
            <RefreshCw size={13} /> Fetch
          </Button>
          <Button size="sm" variant="ghost" onClick={() => run(() => window.api.git.pull(path), 'Pulled')}>
            <ArrowDown size={13} /> Pull
          </Button>
          <Button size="sm" variant="ghost" onClick={() => run(() => window.api.git.push(path), 'Pushed')}>
            <ArrowUp size={13} /> Push
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMergeOpen(true)}>
            <GitMerge size={13} /> Merge
          </Button>
        </div>
      </div>

      {/* Open-in bar */}
      <div className="flex items-center gap-1.5 border-b border-line px-4 py-1.5 text-[11px] text-ink-faint">
        <span className="font-semibold">Open in:</span>
        {EDITORS.map((ed) => (
          <button
            key={ed.label}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-bg-hover hover:text-ink"
            onClick={() =>
              ed.command ? window.api.app.openEditor(ed.command, path) : window.api.app.openPath(path)
            }
          >
            {ed.label === 'Explorer' ? <FolderOpen size={12} /> : <ExternalLink size={12} />}
            {ed.label}
          </button>
        ))}
      </div>

      {note && (
        <div className={cn('px-4 py-1.5 text-xs', note.bad ? 'text-bad' : 'text-ok')}>{note.text}</div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[1fr,340px]">
        {/* Changes */}
        <div className="flex min-h-0 flex-col overflow-y-auto border-r border-line p-4">
          <FileSection
            title="Unstaged changes"
            files={status?.unstaged ?? []}
            actionLabel="Stage"
            onAction={(files) => run(() => window.api.git.stage(path, files))}
            onSecondary={(files) =>
              confirm(`Discard changes to ${files.length} file(s)?`) &&
              run(() => window.api.git.discard(path, files))
            }
            secondaryLabel="Discard"
            allLabel="Stage all"
            onAll={() => run(() => window.api.git.stageAll(path))}
          />
          <div className="h-4" />
          <FileSection
            title="Staged changes"
            files={status?.staged ?? []}
            actionLabel="Unstage"
            onAction={(files) => run(() => window.api.git.unstage(path, files))}
            allLabel="Unstage all"
            onAll={() => run(() => window.api.git.unstageAll(path))}
          />

          <div className="mt-4">
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
              Commit message
            </div>
            <textarea
              className="field-input min-h-[60px] resize-none font-mono"
              placeholder="Describe your changes…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit(false)
              }}
            />
            <div className="mt-2 flex gap-2">
              <Button
                className="flex-1"
                disabled={!message.trim() || !(status?.staged.length ?? 0)}
                onClick={() => doCommit(false)}
              >
                Commit
              </Button>
              <Button
                variant="ghost"
                className="flex-1"
                disabled={!message.trim() || !(status?.staged.length ?? 0)}
                onClick={() => doCommit(true)}
              >
                Commit & Push
              </Button>
            </div>
          </div>
        </div>

        {/* History: Commits / Graph */}
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-1 border-b border-line px-2">
            <HistoryTabButton id="commits" active={histTab} onClick={setHistTab} icon={<List size={13} />}>
              Commits
            </HistoryTabButton>
            <HistoryTabButton id="graph" active={histTab} onClick={setHistTab} icon={<Network size={13} />}>
              Graph
            </HistoryTabButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {histTab === 'commits' ? (
              <CommitsList log={log} onTag={setTagFor} />
            ) : (
              <GraphView commits={graph} onTag={setTagFor} />
            )}
          </div>
        </div>
      </div>

      {mergeOpen && status && (
        <MergeDialog
          status={status}
          onClose={() => setMergeOpen(false)}
          onMerge={(branch) => {
            setMergeOpen(false)
            run(() => window.api.git.merge(path, branch), `Merged ${branch}`)
          }}
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

  async function doCommit(push: boolean): Promise<void> {
    const msg = message.trim()
    if (!msg) return
    setBusy(true)
    setNote(null)
    const c = await window.api.git.commit(path, msg)
    if (!c.ok) {
      setBusy(false)
      setNote({ text: c.error, bad: true })
      return
    }
    if (push) {
      const p = await window.api.git.push(path)
      if (!p.ok) {
        setBusy(false)
        setNote({ text: p.error, bad: true })
        await refresh()
        return
      }
    }
    setBusy(false)
    setMessage('')
    setNote({ text: push ? 'Committed & pushed' : 'Committed' })
    await refresh()
  }
}

// ---- Branch picker (searchable) ----

function SearchableBranchList({
  locals,
  remotes,
  current,
  onPick,
  autoFocus
}: {
  locals: string[]
  remotes: string[]
  current?: string
  onPick: (value: string) => void
  autoFocus?: boolean
}): ReactNode {
  const [q, setQ] = useState('')
  const ql = q.toLowerCase().trim()
  const fL = locals.filter((b) => b.toLowerCase().includes(ql))
  const fR = remotes.filter((b) => b.toLowerCase().includes(ql))
  return (
    <div>
      <div className="relative mb-1.5">
        <Search size={13} className="pointer-events-none absolute left-2 top-2 text-ink-faint" />
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search branches…"
          className="w-full rounded-md bg-bg-input py-1.5 pl-7 pr-2 text-xs outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-accent"
        />
      </div>
      <div className="max-h-72 overflow-y-auto">
        {fL.length > 0 && (
          <div className="px-2 pb-0.5 pt-1 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
            Local
          </div>
        )}
        {fL.map((b) => (
          <button
            key={b}
            onClick={() => onPick(b)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-bg-hover"
          >
            <GitBranch size={12} className="shrink-0 text-ink-faint" />
            <span className="min-w-0 flex-1 truncate">{b}</span>
            {b === current && <Check size={12} className="shrink-0 text-accent" />}
          </button>
        ))}
        {fR.length > 0 && (
          <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
            Remote
          </div>
        )}
        {fR.map((b) => (
          <button
            key={b}
            onClick={() => onPick(b)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-ink-soft hover:bg-bg-hover"
          >
            <GitBranch size={12} className="shrink-0 text-ink-faint/70" />
            <span className="min-w-0 flex-1 truncate">{b}</span>
          </button>
        ))}
        {fL.length === 0 && fR.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-ink-faint">No matching branches.</div>
        )}
      </div>
    </div>
  )
}

function BranchPicker({
  status,
  onPick
}: {
  status: GitStatus
  onPick: (value: string, isLocal: boolean) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const remotes = status.remoteBranches.filter(
    (rb) => !status.branches.includes(rb.replace(/^[^/]+\//, ''))
  )
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[240px] items-center gap-1.5 rounded-md border border-line bg-bg-input px-2 py-1 text-[13px] font-semibold outline-none hover:border-accent"
      >
        <span className="truncate">{status.branch || 'detached HEAD'}</span>
        <ChevronDown size={13} className="shrink-0 text-ink-faint" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-line bg-bg-panel p-1.5 shadow-xl">
            <SearchableBranchList
              autoFocus
              locals={status.branches}
              remotes={remotes}
              current={status.branch}
              onPick={(v) => {
                setOpen(false)
                onPick(v, status.branches.includes(v))
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function MergeDialog({
  status,
  onClose,
  onMerge
}: {
  status: GitStatus
  onClose: () => void
  onMerge: (branch: string) => void
}): ReactNode {
  const locals = status.branches.filter((b) => b !== status.branch)
  const remotes = status.remoteBranches
  return (
    <Modal title={`Merge into ${status.branch || 'current branch'}`} width={420} onClose={onClose}>
      <p className="mb-2 text-xs text-ink-faint">
        Pick a branch to merge into your current branch. Conflicts will be reported.
      </p>
      <SearchableBranchList autoFocus locals={locals} remotes={remotes} onPick={onMerge} />
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

function HistoryTabButton({
  id,
  active,
  onClick,
  icon,
  children
}: {
  id: HistTab
  active: HistTab
  onClick: (id: HistTab) => void
  icon: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <button
      onClick={() => onClick(id)}
      className={cn(
        'flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] font-semibold transition-colors',
        active === id ? 'border-accent text-ink' : 'border-transparent text-ink-soft hover:text-ink'
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function CommitsList({
  log,
  onTag
}: {
  log: GitCommit[]
  onTag: (c: TagTarget) => void
}): ReactNode {
  if (log.length === 0) return <div className="p-4 text-xs text-ink-faint">No commits yet.</div>
  return (
    <div className="space-y-1 p-3">
      {log.map((c) => (
        <div
          key={c.hash}
          className="group relative rounded-lg border border-line bg-bg-panel px-3 py-2"
        >
          <div className="truncate text-[13px] font-medium" title={c.message}>
            {c.message}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-ink-faint">
            <span className="font-mono text-accent">{c.hash}</span> · {c.author} · {c.relative}
          </div>
          <button
            title="Tag this commit"
            onClick={() => onTag({ hash: c.hash, message: c.message })}
            className="absolute right-2 top-2 rounded p-1 text-ink-faint opacity-0 hover:bg-bg-hover hover:text-accent group-hover:opacity-100"
          >
            <Tag size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ---- Branch graph ----

const LANE_COLORS = [
  '#6d8cff',
  '#46c08a',
  '#e0b341',
  '#b07ee6',
  '#e0625e',
  '#56c7d6',
  '#e0883c',
  '#9aa1ad'
]
const ROW_H = 30
const LANE_W = 14
const PAD_X = 14
const NODE_R = 4

const colX = (i: number): number => PAD_X + i * LANE_W
const laneColor = (i: number): string => LANE_COLORS[((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]

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

function buildGraph(commits: GitGraphCommit[]): { rows: GraphRow[]; segments: Seg[]; width: number; height: number } {
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

    // pass-through lanes (unchanged, non-null) -> full-height vertical
    const n = Math.max(before.length, after.length)
    for (let i = 0; i < n; i++) {
      if (before[i] != null && after[i] === before[i]) line(colX(i), yTop, colX(i), yBot, i)
    }
    // incoming line straight into the node
    if (before[col] === c.hash) line(colX(col), yTop, colX(col), yMid, col)
    // other children lanes converging into this commit
    for (const m of incoming) if (m !== col) line(colX(m), yTop, colX(col), yMid, m)
    // node down to each parent's lane
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
        isTag
          ? 'bg-warn/15 text-warn'
          : remote
            ? 'bg-bg-elevated text-ink-faint'
            : 'bg-accent-dim text-accent-hover'
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
  onTag
}: {
  commits: GitGraphCommit[]
  onTag: (c: TagTarget) => void
}): ReactNode {
  const { rows, segments, width, height } = useMemo(() => buildGraph(commits), [commits])
  if (commits.length === 0)
    return <div className="p-4 text-xs text-ink-faint">No commits to graph.</div>
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
          return (
            <div
              key={i}
              style={{ height: ROW_H }}
              className="group flex items-center gap-1.5 px-2 hover:bg-bg-hover/40"
            >
              {row.commit.refs.map((r) => (
                <RefChip key={r} name={r} />
              ))}
              <span className="min-w-0 flex-1 truncate" title={row.commit.message}>
                {row.commit.message}
              </span>
              <button
                title="Tag this commit"
                onClick={() => onTag({ hash: short, message: row.commit.message })}
                className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:text-accent group-hover:opacity-100"
              >
                <Tag size={12} />
              </button>
              <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                {short} · {row.commit.relative}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FileSection({
  title,
  files,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  allLabel,
  onAll
}: {
  title: string
  files: GitFile[]
  actionLabel: string
  onAction: (files: string[]) => void
  secondaryLabel?: string
  onSecondary?: (files: string[]) => void
  allLabel: string
  onAll: () => void
}): ReactNode {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">
          {title} {files.length > 0 && <span className="text-ink-soft">({files.length})</span>}
        </span>
        {files.length > 0 && (
          <button className="text-[11px] font-semibold text-accent hover:text-accent-hover" onClick={onAll}>
            {allLabel}
          </button>
        )}
      </div>
      <div className="rounded-lg border border-line bg-bg-panel">
        {files.length === 0 ? (
          <div className="px-3 py-3 text-xs text-ink-faint">Nothing here.</div>
        ) : (
          files.map((f) => (
            <div
              key={f.path}
              className="group flex items-center gap-2 border-b border-line/60 px-3 py-1.5 last:border-0"
            >
              <span
                className="w-3 shrink-0 text-center font-mono text-xs font-bold"
                style={{ color: CODE_COLOR[f.code] ?? '#9aa1ad' }}
              >
                {f.code === '?' ? 'U' : f.code}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                {f.path}
              </span>
              <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
                {secondaryLabel && onSecondary && (
                  <button
                    className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft hover:bg-bg-hover hover:text-bad"
                    onClick={() => onSecondary([f.path])}
                  >
                    {secondaryLabel}
                  </button>
                )}
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-accent hover:bg-bg-hover"
                  onClick={() => onAction([f.path])}
                >
                  {actionLabel}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
