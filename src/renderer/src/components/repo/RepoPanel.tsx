import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  GitBranch,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  FolderOpen,
  FolderGit2,
  ExternalLink
} from 'lucide-react'
import type { Project, GitStatus, GitCommit, GitFile } from '@shared/types'
import { useApp } from '../../store'
import { Button, Spinner, cn } from '../../lib/ui'

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

export default function RepoPanel({ project }: { project: Project }): ReactNode {
  const upsertProject = useApp((s) => s.upsertProject)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitCommit[]>([])
  const [message, setMessage] = useState('')
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const path = project.repoPath

  const refresh = useCallback(async () => {
    if (!path) return
    const [st, lg] = await Promise.all([window.api.git.status(path), window.api.git.log(path)])
    if (st.ok && st.data) setStatus(st.data)
    if (lg.ok && lg.data) setLog(lg.data)
  }, [path])

  useEffect(() => {
    refresh()
  }, [refresh])

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string): Promise<void> => {
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
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FolderGit2 size={44} className="text-ink-faint" />
        <div className="text-[15px] font-semibold text-ink-soft">Not a Git repository</div>
        <div className="max-w-md break-all text-xs text-ink-faint">{path}</div>
        <Button variant="ghost" onClick={pickFolder}>
          Change folder
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-line bg-bg-panel px-4 py-2.5">
        <GitBranch size={15} className="text-accent" />
        <select
          value={status?.branch ?? ''}
          onChange={(e) => {
            const v = e.target.value
            if (status?.branches.includes(v)) run(() => window.api.git.checkout(path, v), `Switched to ${v}`)
            else run(() => window.api.git.checkoutRemote(path, v), `Checked out ${v}`)
          }}
          className="max-w-[220px] rounded-md border border-line bg-bg-input px-2 py-1 text-[13px] font-semibold outline-none focus:border-accent"
        >
          <optgroup label="Local">
            {status?.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </optgroup>
          {status && status.remoteBranches.length > 0 && (
            <optgroup label="Remote">
              {status.remoteBranches
                .filter((rb) => !status.branches.includes(rb.replace(/^[^/]+\//, '')))
                .map((rb) => (
                  <option key={rb} value={rb}>
                    {rb}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
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

      <div className="grid min-h-0 flex-1 grid-cols-[1fr,300px]">
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

        {/* History */}
        <div className="flex min-h-0 flex-col overflow-y-auto p-4">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
            Recent commits
          </div>
          <div className="space-y-1">
            {log.map((c) => (
              <div key={c.hash} className="rounded-lg border border-line bg-bg-panel px-3 py-2">
                <div className="truncate text-[13px] font-medium" title={c.message}>
                  {c.message}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-ink-faint">
                  <span className="font-mono text-accent">{c.hash}</span> · {c.author} · {c.relative}
                </div>
              </div>
            ))}
            {log.length === 0 && <div className="text-xs text-ink-faint">No commits yet.</div>}
          </div>
        </div>
      </div>
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
