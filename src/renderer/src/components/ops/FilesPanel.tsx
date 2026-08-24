import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  FileArchive,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  FolderUp,
  Home,
  Link2,
  Lock,
  Pencil,
  RotateCw,
  Scissors,
  Terminal,
  Trash2,
  Upload
} from 'lucide-react'
import type { RemoteEntry, RemoteHostInfo, Server, TransferProgress } from '@shared/types'
import { cn, AnchorMenu, Modal, Button, Input, EmptyState } from '../../lib/ui'
import { toast } from '../../lib/toast'
import { copyText } from '../../lib/format'
import {
  FilterInput,
  Loading,
  PanelError,
  Td,
  Th,
  ToolButton,
  formatBytes,
  formatWhen
} from './common'

const PLACES: { label: string; path: string }[] = [
  { label: '/', path: '/' },
  { label: '/etc', path: '/etc' },
  { label: '/var/log', path: '/var/log' },
  { label: '/var/www', path: '/var/www' },
  { label: '/opt', path: '/opt' },
  { label: '/srv', path: '/srv' },
  { label: '/tmp', path: '/tmp' }
]

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|gz|bz2|xz|7z|rar)$/i
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i
const CODE_RE = /\.(json|ya?ml|toml|ini|conf|cfg|env|js|ts|tsx|jsx|py|rb|go|rs|php|java|c|h|cpp|sql|html?|css|scss|xml)$/i
const SCRIPT_RE = /\.(sh|bash|zsh|service|timer)$/i

function entryIcon(entry: RemoteEntry): ReactNode {
  if (entry.type === 'dir') return <Folder size={15} className="text-accent" />
  if (entry.type === 'link')
    return <Link2 size={15} className={entry.linkDir ? 'text-accent' : 'text-ink-faint'} />
  if (ARCHIVE_RE.test(entry.name)) return <FileArchive size={15} className="text-warn" />
  if (IMAGE_RE.test(entry.name)) return <FileImage size={15} className="text-ink-soft" />
  if (SCRIPT_RE.test(entry.name)) return <Terminal size={15} className="text-ok" />
  if (CODE_RE.test(entry.name)) return <FileCode2 size={15} className="text-ink-soft" />
  return <FileText size={15} className="text-ink-faint" />
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

type SortKey = 'name' | 'size' | 'mtime'

export default function FilesPanel({
  server,
  info,
  active
}: {
  server: Server
  info?: RemoteHostInfo
  active: boolean
}): ReactNode {
  const home = info?.home ?? '/'
  const [cwd, setCwd] = useState(home)
  const [history, setHistory] = useState<string[]>([home])
  const [historyAt, setHistoryAt] = useState(0)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState<{ op: 'copy' | 'move'; paths: string[] } | null>(null)
  const [filter, setFilter] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false })
  const [editingPath, setEditingPath] = useState(false)
  const [pathDraft, setPathDraft] = useState(cwd)
  const [menu, setMenu] = useState<{
    entry: RemoteEntry | null
    rect: { top: number; bottom: number; left: number; right: number }
  } | null>(null)
  const [prompt, setPrompt] = useState<PromptConfig | null>(null)
  const [viewer, setViewer] = useState<RemoteEntry | null>(null)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const [dropping, setDropping] = useState(false)
  const loadedFor = useRef('')

  const load = useCallback(
    async (path: string): Promise<void> => {
      setLoading(true)
      const res = await window.api.ops.fs.list(server, path)
      setLoading(false)
      if (!res.ok || !res.data) {
        setError(res.ok ? 'Empty response' : res.error)
        return
      }
      setError('')
      setEntries(res.data.entries)
    },
    [server]
  )

  // First visit (and any later cwd change) pulls a listing.
  useEffect(() => {
    if (!active) return
    if (loadedFor.current === cwd) return
    loadedFor.current = cwd
    void load(cwd)
  }, [active, cwd, load])

  useEffect(
    () =>
      window.api.ops.onProgress((p) => {
        if (p.serverId !== server.id) return
        setProgress(p.done ? null : p)
        if (p.done && p.kind === 'upload') void load(cwd)
      }),
    [server.id, cwd, load]
  )

  const refresh = useCallback(() => void load(cwd), [load, cwd])

  const navigate = (path: string): void => {
    setSelection([])
    setCwd(path)
    setPathDraft(path)
    setHistory((h) => [...h.slice(0, historyAt + 1), path])
    setHistoryAt((i) => i + 1)
  }

  const goHistory = (delta: number): void => {
    const next = historyAt + delta
    if (next < 0 || next >= history.length) return
    setHistoryAt(next)
    setSelection([])
    setCwd(history[next])
    setPathDraft(history[next])
  }

  const open = (entry: RemoteEntry): void => {
    if (entry.type === 'dir' || (entry.type === 'link' && entry.linkDir)) navigate(entry.path)
    else setViewer(entry)
  }

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const list = entries.filter(
      (e) =>
        (showHidden || !e.name.startsWith('.')) &&
        (!needle || e.name.toLowerCase().includes(needle))
    )
    const dir = sort.desc ? -1 : 1
    return list.sort((a, b) => {
      const aDir = a.type === 'dir' || (a.type === 'link' && a.linkDir)
      const bDir = b.type === 'dir' || (b.type === 'link' && b.linkDir)
      if (aDir !== bDir) return aDir ? -1 : 1
      if (sort.key === 'size') return (a.size - b.size) * dir
      if (sort.key === 'mtime') return (a.mtime - b.mtime) * dir
      return a.name.localeCompare(b.name) * dir
    })
  }, [entries, filter, showHidden, sort])

  const selected = useMemo(
    () => visible.filter((e) => selection.includes(e.path)),
    [visible, selection]
  )

  const clickRow = (entry: RemoteEntry, e: MouseEvent): void => {
    if (e.shiftKey && anchor) {
      const from = visible.findIndex((x) => x.path === anchor)
      const to = visible.findIndex((x) => x.path === entry.path)
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from]
        setSelection(visible.slice(a, b + 1).map((x) => x.path))
        return
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelection((s) =>
        s.includes(entry.path) ? s.filter((p) => p !== entry.path) : [...s, entry.path]
      )
      setAnchor(entry.path)
      return
    }
    setSelection([entry.path])
    setAnchor(entry.path)
  }

  // ---- actions

  const run = async (
    label: string,
    fn: () => Promise<{ ok: boolean; error?: string }>
  ): Promise<boolean> => {
    const res = await fn()
    if (!res.ok) {
      toast.error(`${label}: ${res.error}`)
      return false
    }
    toast.success(label)
    refresh()
    return true
  }

  const promptNewFolder = (): void =>
    setPrompt({
      title: 'New folder',
      label: 'Folder name',
      value: '',
      confirm: 'Create',
      onSubmit: (name) =>
        run('Folder created', () => window.api.ops.fs.mkdir(server, joinPath(cwd, name)))
    })

  const promptNewFile = (): void =>
    setPrompt({
      title: 'New file',
      label: 'File name',
      value: '',
      confirm: 'Create',
      onSubmit: (name) =>
        run('File created', () => window.api.ops.fs.newFile(server, joinPath(cwd, name)))
    })

  const doDelete = async (targets: RemoteEntry[]): Promise<void> => {
    if (!targets.length) return
    const names = targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} items`
    if (!confirm(`Delete ${names} on ${server.name}? This cannot be undone.`)) return
    await run('Deleted', () => window.api.ops.fs.delete(server, targets.map((t) => t.path)))
    setSelection([])
  }

  const doPaste = async (): Promise<void> => {
    if (!clipboard) return
    const ok = await run(clipboard.op === 'copy' ? 'Copied' : 'Moved', () =>
      window.api.ops.fs.transfer(server, clipboard.op, clipboard.paths, cwd)
    )
    if (ok && clipboard.op === 'move') setClipboard(null)
  }

  const doUpload = async (localPaths?: string[], pickFolders?: boolean): Promise<void> => {
    const res = await window.api.ops.fs.upload(server, cwd, localPaths, pickFolders)
    if (!res.ok) {
      toast.error(`Upload failed: ${res.error}`)
      return
    }
    const done = res.data
    if (done && (done.files || done.folders)) {
      const parts: string[] = []
      if (done.files) parts.push(`${done.files} file${done.files === 1 ? '' : 's'}`)
      if (done.folders) parts.push(`${done.folders} folder${done.folders === 1 ? '' : 's'}`)
      toast.success(`Uploaded ${parts.join(' in ')}`)
    }
    refresh()
  }

  const doDownload = async (entry: RemoteEntry): Promise<void> => {
    const isDir = entry.type === 'dir' || (entry.type === 'link' && entry.linkDir === true)
    const res = await window.api.ops.fs.download(server, entry.path, isDir)
    if (!res.ok) toast.error(`Download failed: ${res.error}`)
    else if (res.data) toast.success(`Saved to ${res.data}`)
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const dropped = Array.from(e.dataTransfer.files)
    if (!dropped.length) return
    try {
      // A dropped folder arrives as one entry; the main process walks it.
      const paths = dropped.map((f) => window.api.ops.pathForFile(f)).filter(Boolean)
      if (paths.length) void doUpload(paths)
    } catch {
      toast.error('Could not read what was dropped — use the Upload button instead.')
    }
  }

  const sortBy = (key: SortKey): void =>
    setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))

  const crumbs = useMemo(() => {
    const parts = cwd.split('/').filter(Boolean)
    const out = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of parts) {
      acc += `/${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }, [cwd])

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-bg-panel px-2 py-1.5">
        <ToolButton icon={<ArrowLeft size={14} />} title="Back" disabled={historyAt === 0} onClick={() => goHistory(-1)} />
        <ToolButton
          icon={<ArrowRight size={14} />}
          title="Forward"
          disabled={historyAt >= history.length - 1}
          onClick={() => goHistory(1)}
        />
        <ToolButton icon={<ArrowUp size={14} />} title="Up one level" disabled={cwd === '/'} onClick={() => navigate(parentPath(cwd))} />
        <ToolButton icon={<Home size={14} />} title={`Home (${home})`} onClick={() => navigate(home)} />
        <ToolButton icon={<RotateCw size={14} />} title="Refresh" onClick={refresh} />
        <div className="mx-1 h-4 w-px bg-line" />
        <ToolButton icon={<Upload size={14} />} onClick={() => void doUpload()}>
          Upload
        </ToolButton>
        <ToolButton
          icon={<FolderUp size={14} />}
          title="Upload a folder (or drop one here)"
          onClick={() => void doUpload(undefined, true)}
        />
        <ToolButton icon={<FolderPlus size={14} />} title="New folder" onClick={promptNewFolder} />
        <ToolButton icon={<FilePlus2 size={14} />} title="New file" onClick={promptNewFile} />
        <ToolButton
          icon={<ClipboardPaste size={14} />}
          title={clipboard ? `Paste ${clipboard.paths.length} item(s)` : 'Nothing copied'}
          disabled={!clipboard}
          onClick={() => void doPaste()}
        />
        <ToolButton
          icon={<Trash2 size={14} />}
          title="Delete selected"
          danger
          disabled={!selected.length}
          onClick={() => void doDelete(selected)}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <FilterInput value={filter} onChange={setFilter} placeholder="Filter…" className="w-36" />
          <ToolButton active={showHidden} onClick={() => setShowHidden((h) => !h)} title="Toggle hidden files">
            .files
          </ToolButton>
        </div>
      </div>

      {/* Path bar + quick places */}
      <div className="flex items-center gap-1 border-b border-line bg-bg-panel px-3 py-1.5">
        {editingPath ? (
          <form
            className="flex flex-1 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              setEditingPath(false)
              if (pathDraft.trim()) navigate(pathDraft.trim())
            }}
          >
            <Input
              autoFocus
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onBlur={() => setEditingPath(false)}
              className="h-7 py-0 text-[12px]"
            />
          </form>
        ) : (
          <div
            className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-[12px]"
            onDoubleClick={() => {
              setPathDraft(cwd)
              setEditingPath(true)
            }}
            title="Double-click to type a path"
          >
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-0.5">
                {i > 0 && <ChevronRight size={11} className="text-ink-faint" />}
                <button
                  className={cn(
                    'rounded px-1 py-0.5 hover:bg-bg-hover',
                    i === crumbs.length - 1 ? 'font-semibold text-ink' : 'text-ink-soft'
                  )}
                  onClick={() => navigate(c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          {PLACES.map((p) => (
            <button
              key={p.path}
              onClick={() => navigate(p.path)}
              className="rounded px-1.5 py-0.5 font-mono text-[11px] text-ink-faint hover:bg-bg-hover hover:text-ink"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <PanelError message={error} onRetry={refresh} />}

      {/* Listing — right-clicking the empty area acts on the folder itself. */}
      <div
        className="min-h-0 flex-1 overflow-auto"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSelection([])
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setSelection([])
          setMenu({
            entry: null,
            rect: { top: e.clientY, bottom: e.clientY, left: e.clientX, right: e.clientX + 150 }
          })
        }}
      >
        {loading && !entries.length ? (
          <Loading label={`Reading ${cwd}…`} />
        ) : !visible.length ? (
          <EmptyState
            icon={<Folder size={38} />}
            title={filter ? 'Nothing matches' : 'Empty folder'}
            subtitle={filter ? 'Try a different filter.' : 'Drop files or folders here to upload them.'}
          />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th onClick={() => sortBy('name')}>Name</Th>
                <Th onClick={() => sortBy('size')} align="right">
                  Size
                </Th>
                <Th onClick={() => sortBy('mtime')}>Modified</Th>
                <Th>Perms</Th>
                <Th>Owner</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const isSelected = selection.includes(entry.path)
                const isDir = entry.type === 'dir' || (entry.type === 'link' && entry.linkDir)
                return (
                  <tr
                    key={entry.path}
                    onClick={(e) => clickRow(entry, e)}
                    onDoubleClick={() => open(entry)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (!selection.includes(entry.path)) setSelection([entry.path])
                      setMenu({
                        entry,
                        rect: { top: e.clientY, bottom: e.clientY, left: e.clientX, right: e.clientX + 150 }
                      })
                    }}
                    className={cn(
                      'cursor-default border-b border-line/40',
                      isSelected ? 'bg-accent-dim' : 'hover:bg-bg-hover'
                    )}
                  >
                    <Td className="max-w-0 truncate">
                      <span className="flex items-center gap-2">
                        {entryIcon(entry)}
                        <span className={cn('truncate', isDir && 'font-semibold')}>{entry.name}</span>
                      </span>
                    </Td>
                    <Td align="right" className="font-mono text-[11px] text-ink-soft">
                      {isDir ? '—' : formatBytes(entry.size)}
                    </Td>
                    <Td className="text-[11px] text-ink-soft">{formatWhen(entry.mtime)}</Td>
                    <Td className="font-mono text-[11px] text-ink-faint">{entry.modeText}</Td>
                    <Td className="text-[11px] text-ink-faint">
                      {entry.owner}
                      {entry.group && entry.group !== entry.owner ? `:${entry.group}` : ''}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 border-t border-line bg-bg-panel px-3 py-1 text-[11px] text-ink-faint">
        <span>
          {visible.length} item{visible.length === 1 ? '' : 's'}
        </span>
        {selected.length > 0 && <span>{selected.length} selected</span>}
        {clipboard && (
          <span>
            {clipboard.paths.length} {clipboard.op === 'copy' ? 'copied' : 'cut'}
          </span>
        )}
        {progress && (
          <span className="ml-auto flex items-center gap-2">
            <span className="truncate">
              {progress.kind === 'upload' ? 'Uploading' : 'Downloading'} {progress.name} (
              {progress.index}/{progress.count})
            </span>
            <span className="h-1.5 w-32 overflow-hidden rounded-full bg-bg-elevated">
              <span
                className="block h-full rounded-full bg-accent"
                style={{
                  width: `${progress.total ? Math.round((progress.transferred / progress.total) * 100) : 0}%`
                }}
              />
            </span>
          </span>
        )}
      </div>

      {dropping && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-accent bg-accent/10">
          <span className="rounded-lg bg-bg-panel px-3 py-2 text-[13px] font-semibold">
            Drop files or folders to upload into {cwd}
          </span>
        </div>
      )}

      {menu && !menu.entry && (
        <SpaceMenu
          rect={menu.rect}
          cwd={cwd}
          clipboard={clipboard}
          showHidden={showHidden}
          onClose={() => setMenu(null)}
          onNewFolder={promptNewFolder}
          onNewFile={promptNewFile}
          onUpload={() => void doUpload()}
          onUploadFolder={() => void doUpload(undefined, true)}
          onPaste={() => void doPaste()}
          onRefresh={refresh}
          onToggleHidden={() => setShowHidden((h) => !h)}
        />
      )}

      {menu && menu.entry && (
        <EntryMenu
          entry={menu.entry}
          rect={menu.rect}
          multiple={selected.length > 1}
          onClose={() => setMenu(null)}
          onOpen={() => open(menu.entry!)}
          onDownload={() => void doDownload(menu.entry!)}
          onCopyPath={() => {
            void copyText(menu.entry!.path)
            toast.success('Path copied')
          }}
          onCopy={() => setClipboard({ op: 'copy', paths: selected.map((s) => s.path) })}
          onCut={() => setClipboard({ op: 'move', paths: selected.map((s) => s.path) })}
          onRename={() =>
            setPrompt({
              title: 'Rename',
              label: 'New name',
              value: menu.entry!.name,
              confirm: 'Rename',
              onSubmit: (name) =>
                run('Renamed', () =>
                  window.api.ops.fs.rename(server, menu.entry!.path, joinPath(cwd, name))
                )
            })
          }
          onChmod={() =>
            setPrompt({
              title: `Permissions — ${menu.entry!.name}`,
              label: 'Octal mode (e.g. 644, 755)',
              value: (menu.entry!.mode & 0o777).toString(8).padStart(3, '0'),
              confirm: 'Apply',
              checkbox: menu.entry!.type === 'dir' ? 'Apply recursively' : undefined,
              onSubmit: (mode, recursive) =>
                run('Permissions updated', () =>
                  window.api.ops.fs.chmod(server, menu.entry!.path, mode, recursive)
                )
            })
          }
          onChown={() =>
            setPrompt({
              title: `Owner — ${menu.entry!.name}`,
              label: 'user or user:group',
              value: menu.entry!.owner || 'root',
              confirm: 'Apply',
              checkbox: menu.entry!.type === 'dir' ? 'Apply recursively' : undefined,
              onSubmit: (owner, recursive) =>
                run('Owner updated', () =>
                  window.api.ops.fs.chown(server, menu.entry!.path, owner, recursive)
                )
            })
          }
          onCompress={() =>
            setPrompt({
              title: 'Compress',
              label: 'Archive name',
              value: `${selected.length > 1 ? 'archive' : menu.entry!.name}.tar.gz`,
              confirm: 'Create',
              onSubmit: async (name) => {
                const res = await window.api.ops.fs.archive(
                  server,
                  selected.map((s) => s.path),
                  cwd,
                  name
                )
                if (!res.ok) toast.error(`Compress failed: ${res.error}`)
                else {
                  toast.success('Archive created')
                  refresh()
                }
              }
            })
          }
          onExtract={() =>
            void run('Extracted', () =>
              window.api.ops.fs.extract(server, menu.entry!.path, cwd)
            )
          }
          onSize={async () => {
            const res = await window.api.ops.fs.size(server, menu.entry!.path)
            if (res.ok) toast.info(`${menu.entry!.name}: ${res.data}`)
            else toast.error(res.error)
          }}
          onDelete={() => void doDelete(selected.length ? selected : [menu.entry!])}
        />
      )}

      {prompt && <TextPrompt config={prompt} onClose={() => setPrompt(null)} />}
      {viewer &&
        (IMAGE_RE.test(viewer.name) ? (
          <ImageViewer
            server={server}
            entry={viewer}
            onClose={() => setViewer(null)}
            onDownload={() => void doDownload(viewer)}
          />
        ) : (
          <FileViewer
            server={server}
            entry={viewer}
            onClose={() => setViewer(null)}
            onSaved={refresh}
          />
        ))}
    </div>
  )
}

// -------------------------------------------------------------- context menus

/** Shared row renderer for both context menus. */
function MenuItem({
  icon,
  label,
  onClick,
  onClose,
  danger,
  disabled
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  onClose: () => void
  danger?: boolean
  disabled?: boolean
}): ReactNode {
  return (
    <button
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        danger ? 'text-bad' : 'text-ink'
      )}
      onClick={() => {
        onClick()
        onClose()
      }}
    >
      {icon}
      {label}
    </button>
  )
}

/** Right-click on empty space — actions that apply to the current folder. */
function SpaceMenu({
  rect,
  cwd,
  clipboard,
  showHidden,
  onClose,
  onNewFolder,
  onNewFile,
  onUpload,
  onUploadFolder,
  onPaste,
  onRefresh,
  onToggleHidden
}: {
  rect: { top: number; bottom: number; left: number; right: number }
  cwd: string
  clipboard: { op: 'copy' | 'move'; paths: string[] } | null
  showHidden: boolean
  onClose: () => void
  onNewFolder: () => void
  onNewFile: () => void
  onUpload: () => void
  onUploadFolder: () => void
  onPaste: () => void
  onRefresh: () => void
  onToggleHidden: () => void
}): ReactNode {
  return (
    <AnchorMenu anchor={rect} onClose={onClose} width={200}>
      <div className="truncate px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
        {cwd}
      </div>
      <div className="my-1 h-px bg-line" />
      <MenuItem icon={<FolderPlus size={13} />} label="New folder" onClick={onNewFolder} onClose={onClose} />
      <MenuItem icon={<FilePlus2 size={13} />} label="New file" onClick={onNewFile} onClose={onClose} />
      <MenuItem icon={<Upload size={13} />} label="Upload files here" onClick={onUpload} onClose={onClose} />
      <MenuItem
        icon={<FolderUp size={13} />}
        label="Upload folder here"
        onClick={onUploadFolder}
        onClose={onClose}
      />
      <MenuItem
        icon={<ClipboardPaste size={13} />}
        label={clipboard ? `Paste ${clipboard.paths.length} item(s)` : 'Paste'}
        disabled={!clipboard}
        onClick={onPaste}
        onClose={onClose}
      />
      <div className="my-1 h-px bg-line" />
      <MenuItem
        icon={<Eye size={13} />}
        label={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
        onClick={onToggleHidden}
        onClose={onClose}
      />
      <MenuItem icon={<RotateCw size={13} />} label="Refresh" onClick={onRefresh} onClose={onClose} />
    </AnchorMenu>
  )
}

function EntryMenu({
  entry,
  rect,
  multiple,
  onClose,
  onOpen,
  onDownload,
  onCopyPath,
  onCopy,
  onCut,
  onRename,
  onChmod,
  onChown,
  onCompress,
  onExtract,
  onSize,
  onDelete
}: {
  entry: RemoteEntry
  rect: { top: number; bottom: number; left: number; right: number }
  multiple: boolean
  onClose: () => void
  onOpen: () => void
  onDownload: () => void
  onCopyPath: () => void
  onCopy: () => void
  onCut: () => void
  onRename: () => void
  onChmod: () => void
  onChown: () => void
  onCompress: () => void
  onExtract: () => void
  onSize: () => void
  onDelete: () => void
}): ReactNode {
  const isDir = entry.type === 'dir' || (entry.type === 'link' && entry.linkDir)
  const item = (
    icon: ReactNode,
    label: string,
    fn: () => void,
    danger = false
  ): ReactNode => (
    <button
      key={label}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover',
        danger ? 'text-bad' : 'text-ink'
      )}
      onClick={() => {
        fn()
        onClose()
      }}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <AnchorMenu anchor={rect} onClose={onClose} width={186}>
      {!multiple &&
        item(
          isDir ? <Folder size={13} /> : IMAGE_RE.test(entry.name) ? <FileImage size={13} /> : <FileText size={13} />,
          isDir ? 'Open' : IMAGE_RE.test(entry.name) ? 'Preview' : 'View / edit',
          onOpen
        )}
      {!multiple && item(<Download size={13} />, isDir ? 'Download as .tar.gz' : 'Download', onDownload)}
      <div className="my-1 h-px bg-line" />
      {item(<Copy size={13} />, 'Copy', onCopy)}
      {item(<Scissors size={13} />, 'Cut', onCut)}
      {!multiple && item(<Pencil size={13} />, 'Rename', onRename)}
      {!multiple && item(<Copy size={13} />, 'Copy path', onCopyPath)}
      <div className="my-1 h-px bg-line" />
      {item(<FileArchive size={13} />, 'Compress…', onCompress)}
      {!multiple && ARCHIVE_RE.test(entry.name) && item(<FileArchive size={13} />, 'Extract here', onExtract)}
      {!multiple && isDir && item(<Folder size={13} />, 'Folder size', onSize)}
      {!multiple && item(<Lock size={13} />, 'Permissions…', onChmod)}
      {!multiple && item(<Lock size={13} />, 'Owner…', onChown)}
      <div className="my-1 h-px bg-line" />
      {item(<Trash2 size={13} />, multiple ? 'Delete selected' : 'Delete', onDelete, true)}
    </AnchorMenu>
  )
}

// -------------------------------------------------------------------- prompt

interface PromptConfig {
  title: string
  label: string
  value: string
  confirm: string
  /** optional extra toggle, e.g. "apply recursively". */
  checkbox?: string
  /** any return value is ignored — awaited only to keep the dialog busy. */
  onSubmit: (value: string, checked: boolean) => unknown
}

function TextPrompt({
  config,
  onClose
}: {
  config: PromptConfig
  onClose: () => void
}): ReactNode {
  const [value, setValue] = useState(config.value)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!value.trim()) return
    setBusy(true)
    await config.onSubmit(value.trim(), checked)
    setBusy(false)
    onClose()
  }

  return (
    <Modal title={config.title} onClose={onClose} width={420}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <div className="mb-1.5 text-xs font-semibold text-ink-soft">{config.label}</div>
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {config.checkbox && (
          <label className="flex items-center gap-2 text-[12px] text-ink-soft">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {config.checkbox}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !value.trim()}>
            {busy ? 'Working…' : config.confirm}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// --------------------------------------------------------------- file viewer

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

function imageMime(name: string): string {
  return IMAGE_MIME[name.toLowerCase().split('.').pop() ?? ''] ?? 'image/png'
}

/** Preview for image files: pulled over SFTP and inlined as a data URL. */
function ImageViewer({
  server,
  entry,
  onClose,
  onDownload
}: {
  server: Server
  entry: RemoteEntry
  onClose: () => void
  onDownload: () => void
}): ReactNode {
  const [src, setSrc] = useState('')
  const [size, setSize] = useState(entry.size)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [error, setError] = useState('')
  const [fit, setFit] = useState(true)

  useEffect(() => {
    let cancelled = false
    void window.api.ops.fs.readBinary(server, entry.path).then((res) => {
      if (cancelled) return
      if (!res.ok || !res.data) {
        setError(res.ok ? 'Empty response' : res.error)
        return
      }
      setSize(res.data.size)
      setSrc(`data:${imageMime(entry.name)};base64,${res.data.base64}`)
    })
    return () => {
      cancelled = true
    }
  }, [server, entry.path, entry.name])

  return (
    <Modal title={entry.path} onClose={onClose} width={1000}>
      <div className="flex h-[68vh] flex-col gap-2">
        <div className="flex items-center gap-3 text-[11px] text-ink-faint">
          <span>{formatBytes(size)}</span>
          {dims && (
            <span>
              {dims.w} × {dims.h} px
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <ToolButton active={fit} onClick={() => setFit(true)}>
              Fit
            </ToolButton>
            <ToolButton active={!fit} onClick={() => setFit(false)}>
              1:1
            </ToolButton>
            <ToolButton icon={<Download size={13} />} onClick={onDownload}>
              Download
            </ToolButton>
          </div>
        </div>
        {error ? (
          <PanelError message={error} />
        ) : !src ? (
          <Loading label="Fetching image…" />
        ) : (
          <div
            className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-line p-3"
            // Checkerboard so transparent PNGs read correctly on a dark panel.
            style={{
              backgroundColor: '#14161b',
              backgroundImage:
                'linear-gradient(45deg, #1c1f26 25%, transparent 25%), linear-gradient(-45deg, #1c1f26 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1c1f26 75%), linear-gradient(-45deg, transparent 75%, #1c1f26 75%)',
              backgroundSize: '16px 16px',
              backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px'
            }}
          >
            <img
              src={src}
              alt={entry.name}
              draggable={false}
              onLoad={(e) =>
                setDims({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight
                })
              }
              className={cn(fit ? 'max-h-full max-w-full object-contain' : 'max-w-none')}
            />
          </div>
        )}
      </div>
    </Modal>
  )
}

function FileViewer({
  server,
  entry,
  onClose,
  onSaved
}: {
  server: Server
  entry: RemoteEntry
  onClose: () => void
  onSaved: () => void
}): ReactNode {
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [meta, setMeta] = useState<{ truncated: boolean; binary: boolean; size: number } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [following, setFollowing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    void window.api.ops.fs.read(server, entry.path).then((res) => {
      if (cancelled) return
      setBusy(false)
      if (!res.ok || !res.data) {
        setError(res.ok ? 'Empty response' : res.error)
        return
      }
      setContent(res.data.content)
      setOriginal(res.data.content)
      setMeta({ truncated: res.data.truncated, binary: res.data.binary, size: res.data.size })
    })
    return () => {
      cancelled = true
    }
  }, [server, entry.path])

  // "Follow" keeps pulling the tail of a growing log file.
  useEffect(() => {
    if (!following) return
    const pull = (): void => {
      void window.api.ops.fs.tail(server, entry.path, 400).then((res) => {
        if (res.ok && res.data !== undefined) {
          setContent(res.data)
          setOriginal(res.data)
        }
      })
    }
    pull()
    const id = setInterval(pull, 3000)
    return () => clearInterval(id)
  }, [following, server, entry.path])

  const save = async (): Promise<void> => {
    setBusy(true)
    const res = await window.api.ops.fs.write(server, entry.path, content)
    setBusy(false)
    if (!res.ok) {
      toast.error(`Save failed: ${res.error}`)
      return
    }
    toast.success(`Saved ${entry.name}`)
    setOriginal(content)
    onSaved()
  }

  const dirty = content !== original

  return (
    <Modal title={entry.path} onClose={onClose} width={900}>
      <div className="flex h-[62vh] flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px] text-ink-faint">
          <span>{formatBytes(meta?.size ?? entry.size)}</span>
          {meta?.truncated && <span className="text-warn">Showing the first 2 MB only</span>}
          {meta?.binary && <span className="text-warn">Binary file — not editable</span>}
          {dirty && <span className="text-accent-hover">Unsaved changes</span>}
          <div className="ml-auto flex items-center gap-1">
            <ToolButton active={following} onClick={() => setFollowing((f) => !f)} title="Poll the end of the file every 3s">
              Follow tail
            </ToolButton>
            <Button
              size="sm"
              disabled={busy || meta?.binary || following || !dirty}
              onClick={() => void save()}
            >
              {busy ? 'Working…' : 'Save'}
            </Button>
          </div>
        </div>
        {error ? (
          <PanelError message={error} />
        ) : busy && !content ? (
          <Loading />
        ) : (
          <textarea
            value={content}
            readOnly={meta?.binary || following}
            spellCheck={false}
            onChange={(e) => setContent(e.target.value)}
            className="min-h-0 flex-1 resize-none rounded-lg border border-line bg-bg-input p-3 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent"
          />
        )}
      </div>
    </Modal>
  )
}
