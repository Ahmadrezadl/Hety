import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Download,
  Copy,
  ChevronDown,
  AlertCircle,
  Trash2,
  Undo2,
  UploadCloud,
  RotateCcw,
  Search,
  Lock,
  ArrowUp,
  ArrowDown
} from 'lucide-react'
import type { QueryResult, SchemaColumn, RowChanges } from '@shared/types'
import { toCsv, toTsv, toMarkdown, copyText, cellString } from '../../lib/format'
import { Spinner, cn } from '../../lib/ui'

type Fmt = 'csv' | 'tsv' | 'markdown'
type EditKind = 'datetime' | 'date' | 'time' | 'bool' | 'text'

const FORMATS: { id: Fmt; label: string; ext: string; fn: (r: QueryResult) => string }[] = [
  { id: 'markdown', label: 'Markdown', ext: 'md', fn: toMarkdown },
  { id: 'csv', label: 'CSV', ext: 'csv', fn: toCsv },
  { id: 'tsv', label: 'TSV', ext: 'tsv', fn: toTsv }
]

interface EditContext {
  connectionId: string
  table: string
  columns: SchemaColumn[]
}

function inputKind(type: string): EditKind {
  const t = (type || '').toLowerCase()
  if (t.includes('timestamp')) return 'datetime'
  if (t === 'date') return 'date'
  if (t.includes('time')) return 'time'
  if (t.includes('bool')) return 'bool'
  return 'text'
}

/** Format a stored value into a `datetime-local` input string in local time. */
function toLocalInputValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  const d = new Date(v as string)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Validate + convert a plain-text edit. Throws on a type mismatch. */
function coerceText(type: string, raw: string): unknown {
  const t = (type || '').toLowerCase()
  if (raw === '') return null
  if (/(smallint|integer|bigint|int2|int4|int8|serial)/.test(t)) {
    if (!/^-?\d+$/.test(raw.trim())) throw new Error(`“${raw}” is not a valid integer`)
    return Number(raw.trim())
  }
  if (/(numeric|decimal|real|double|float|money)/.test(t)) {
    const n = Number(raw.trim())
    if (Number.isNaN(n)) throw new Error(`“${raw}” is not a valid number`)
    return n
  }
  return raw
}

export default function ResultsGrid({
  result,
  error,
  running,
  editContext,
  locked,
  onReload,
  sort,
  onSort
}: {
  result: QueryResult | null
  error: string | null
  running: boolean
  editContext?: EditContext
  locked?: boolean
  onReload?: () => void
  sort?: { column: string; dir: 'asc' | 'desc' } | null
  onSort?: (column: string) => void
}): ReactNode {
  const [menu, setMenu] = useState<'copy' | 'save' | null>(null)
  const [search, setSearch] = useState('')
  const [edits, setEdits] = useState<Record<number, Record<number, unknown>>>({})
  const [deleted, setDeleted] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [cellError, setCellError] = useState<string | null>(null)
  const [pushing, setPushing] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)

  useEffect(() => {
    setEdits({})
    setDeleted(new Set())
    setEditing(null)
    setCellError(null)
    setPushError(null)
  }, [result])

  const columns = result?.columns ?? []

  const meta = useMemo(() => {
    const byName = new Map<string, SchemaColumn>()
    if (editContext) for (const c of editContext.columns) byName.set(c.name, c)
    const pkCols = editContext ? editContext.columns.filter((c) => c.pk).map((c) => c.name) : []
    const hasPk = pkCols.length > 0 && pkCols.every((n) => columns.includes(n))
    return { byName, pkCols, hasPk }
  }, [editContext, columns])

  const editable = !!editContext && meta.hasPk && !locked

  const updatedRowCount = Object.keys(edits).filter(
    (r) => !deleted.has(Number(r)) && Object.keys(edits[Number(r)]).length > 0
  ).length
  const totalChanges = updatedRowCount + deleted.size

  const typeOf = (c: number): string => meta.byName.get(columns[c])?.type ?? 'text'
  const displayValue = (r: number, c: number): unknown => {
    const e = edits[r]
    if (e && c in e) return e[c]
    return result!.rows[r][c]
  }
  const isDirty = (r: number, c: number): boolean => !!edits[r] && c in edits[r]

  const beginEdit = (r: number, c: number): void => {
    if (!editable || deleted.has(r)) return
    const kind = inputKind(typeOf(c))
    const v = displayValue(r, c)
    let init = ''
    if (v !== null && v !== undefined) {
      if (kind === 'datetime') init = toLocalInputValue(v)
      else if (kind === 'date') init = String(v).slice(0, 10)
      else if (kind === 'time') init = String(v).slice(0, 8)
      else if (kind === 'bool') init = v === true || v === 'true' || v === 't' ? 'true' : 'false'
      else init = String(v)
    }
    setEditing({ r, c })
    setEditingValue(init)
    setCellError(null)
  }

  const commitValue = (raw: string): void => {
    if (!editing) return
    const { r, c } = editing
    const type = typeOf(c)
    const kind = inputKind(type)
    const original = result!.rows[r][c]
    let value: unknown
    try {
      if (raw === '') value = null
      else if (kind === 'datetime') {
        // input is local wall-clock; store as UTC
        if (raw === toLocalInputValue(original)) {
          setEditing(null)
          return
        }
        const d = new Date(raw)
        if (Number.isNaN(d.getTime())) throw new Error('Invalid date/time')
        value = d.toISOString()
      } else if (kind === 'date' || kind === 'time') {
        value = raw
      } else if (kind === 'bool') {
        value = raw === 'true'
      } else {
        value = coerceText(type, raw)
      }
    } catch (e) {
      setCellError((e as Error).message)
      return
    }

    setEdits((prev) => {
      const next = { ...prev }
      const row = { ...(next[r] ?? {}) }
      const same = (value === null && original === null) || String(value) === String(original)
      if (same) delete row[c]
      else row[c] = value
      if (Object.keys(row).length) next[r] = row
      else delete next[r]
      return next
    })
    setEditing(null)
    setCellError(null)
  }

  const toggleDelete = (r: number): void =>
    setDeleted((prev) => {
      const n = new Set(prev)
      n.has(r) ? n.delete(r) : n.add(r)
      return n
    })

  const revert = (): void => {
    setEdits({})
    setDeleted(new Set())
    setEditing(null)
    setCellError(null)
    setPushError(null)
  }

  const pkWhere = (r: number): Record<string, unknown> =>
    Object.fromEntries(meta.pkCols.map((name) => [name, result!.rows[r][columns.indexOf(name)]]))

  const push = async (): Promise<void> => {
    if (!editContext) return
    setPushing(true)
    setPushError(null)
    const updates: RowChanges['updates'] = []
    for (const rStr of Object.keys(edits)) {
      const r = Number(rStr)
      if (deleted.has(r)) continue
      const cols = edits[r]
      const set: Record<string, unknown> = {}
      for (const cStr of Object.keys(cols)) set[columns[Number(cStr)]] = cols[Number(cStr)]
      if (Object.keys(set).length) updates.push({ where: pkWhere(r), set })
    }
    const deletes: RowChanges['deletes'] = [...deleted].map((r) => ({ where: pkWhere(r) }))
    const res = await window.api.db.applyChanges(editContext.connectionId, editContext.table, {
      updates,
      deletes
    })
    setPushing(false)
    if (!res.ok) {
      setPushError(res.error)
      return
    }
    onReload?.()
  }

  const copy = async (fmt: Fmt): Promise<void> => {
    if (!result) return
    await copyText(FORMATS.find((x) => x.id === fmt)!.fn(result))
    setMenu(null)
  }
  const save = async (fmt: Fmt): Promise<void> => {
    if (!result) return
    const f = FORMATS.find((x) => x.id === fmt)!
    await window.api.app.saveFile(`query-result.${f.ext}`, f.fn(result))
    setMenu(null)
  }

  const q = search.toLowerCase()
  const rowMatches = (r: number): boolean =>
    !q || columns.some((_, c) => cellString(displayValue(r, c)).toLowerCase().includes(q))

  return (
    <div className="flex h-full flex-col" onClick={() => menu && setMenu(null)}>
      <div className="flex items-center gap-2 border-b border-line bg-bg-panel px-3 py-1.5 text-[11px]">
        {running ? (
          <span className="flex items-center gap-1.5 text-warn">
            <Spinner /> Running…
          </span>
        ) : error ? (
          <span className="flex items-center gap-1.5 text-bad">
            <AlertCircle size={13} /> {error}
          </span>
        ) : result ? (
          <span className="text-ink-soft">
            {result.columns.length > 0
              ? `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}`
              : result.command ?? 'OK'}{' '}
            · {result.elapsedMs} ms
          </span>
        ) : (
          <span className="text-ink-faint">No results yet</span>
        )}

        {editContext && result && result.columns.length > 0 && locked && (
          <span className="flex items-center gap-1 text-warn">
            <Lock size={11} /> locked
          </span>
        )}
        {editContext && result && result.columns.length > 0 && !locked && !meta.hasPk && (
          <span className="text-ink-faint">· read-only (no primary key in result)</span>
        )}
        {pushError && <span className="text-bad">· {pushError}</span>}

        <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {result && result.columns.length > 0 && (
            <div className="relative">
              <Search size={12} className="pointer-events-none absolute left-2 top-1.5 text-ink-faint" />
              <input
                className="w-40 rounded-md bg-bg-input py-1 pl-7 pr-2 text-[11px] outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-accent"
                placeholder="Search results…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}

          {editable && totalChanges > 0 && (
            <>
              <button
                className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
                onClick={revert}
                disabled={pushing}
              >
                <RotateCcw size={12} /> Revert
              </button>
              <button
                className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
                onClick={push}
                disabled={pushing}
              >
                {pushing ? <Spinner /> : <UploadCloud size={12} />} Push ({totalChanges})
              </button>
            </>
          )}
          {result && result.columns.length > 0 && (
            <>
              <ExportButton
                label="Copy"
                icon={<Copy size={12} />}
                open={menu === 'copy'}
                onToggle={() => setMenu(menu === 'copy' ? null : 'copy')}
                onPick={copy}
              />
              <ExportButton
                label="Export"
                icon={<Download size={12} />}
                open={menu === 'save'}
                onToggle={() => setMenu(menu === 'save' ? null : 'save')}
                onPick={save}
              />
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {result && result.columns.length > 0 ? (
          <table className="border-collapse text-[12px]">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="border-b border-r border-line bg-bg-elevated px-2 py-1.5 text-right font-mono text-[10px] text-ink-faint">
                  #
                </th>
                {columns.map((c, i) => {
                  const col = meta.byName.get(c)
                  const sorted = sort && sort.column === c ? sort.dir : null
                  return (
                    <th
                      key={i}
                      className={cn(
                        'whitespace-nowrap border-b border-r border-line bg-bg-elevated px-3 py-1.5 text-left font-bold text-ink-soft',
                        onSort && 'cursor-pointer select-none hover:text-ink'
                      )}
                      title={
                        onSort
                          ? `${col ? `${c} · ${col.type}${col.pk ? ' · PK' : ''}` : c} · click to sort`
                          : col
                            ? `${c} · ${col.type}${col.pk ? ' · PK' : ''}`
                            : c
                      }
                      onClick={onSort ? () => onSort(c) : undefined}
                    >
                      <span className="inline-flex items-center gap-1">
                        {col?.pk && <span className="text-warn">🔑</span>}
                        {c}
                        {sorted === 'asc' && <ArrowUp size={12} className="text-accent" />}
                        {sorted === 'desc' && <ArrowDown size={12} className="text-accent" />}
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((_row, r) => {
                if (!rowMatches(r)) return null
                const isDel = deleted.has(r)
                return (
                  <tr key={r} className={cn(isDel ? 'bg-bad/15' : 'hover:bg-bg-hover/40')}>
                    <td className="group/cell border-b border-r border-line/60 bg-bg-panel px-1 py-1 text-right font-mono text-[10px] text-ink-faint">
                      {editable ? (
                        <button
                          className="inline-flex items-center gap-1"
                          title={isDel ? 'Undo delete' : 'Delete row'}
                          onClick={() => toggleDelete(r)}
                        >
                          <span className={cn(isDel ? 'text-bad' : 'text-ink-faint group-hover/cell:text-bad')}>
                            {isDel ? (
                              <Undo2 size={11} />
                            ) : (
                              <Trash2 size={11} className="opacity-0 group-hover/cell:opacity-100" />
                            )}
                          </span>
                          <span>{r + 1}</span>
                        </button>
                      ) : (
                        r + 1
                      )}
                    </td>
                    {columns.map((_c, c) => {
                      const editingHere = editing?.r === r && editing?.c === c
                      const v = displayValue(r, c)
                      const kind = inputKind(typeOf(c))
                      return (
                        <td
                          key={c}
                          className={cn(
                            'max-w-[420px] truncate border-b border-r border-line/60 px-3 py-1 font-mono',
                            isDirty(r, c) && !isDel && 'bg-warn/20',
                            v === null && !editingHere && 'italic text-ink-faint',
                            isDel && 'line-through opacity-60',
                            editable && !isDel && 'cursor-text'
                          )}
                          title={cellString(v)}
                          onDoubleClick={() => beginEdit(r, c)}
                        >
                          {editingHere ? (
                            <CellEditor
                              kind={kind}
                              value={editingValue}
                              error={!!cellError}
                              onChange={setEditingValue}
                              onCommit={commitValue}
                              onCancel={() => {
                                setEditing(null)
                                setCellError(null)
                              }}
                            />
                          ) : v === null ? (
                            'null'
                          ) : (
                            cellString(v)
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="p-4 text-xs text-ink-faint">
            {result ? 'Statement executed.' : 'Run a query to see results.'}
          </div>
        )}
      </div>

      {cellError && (
        <div className="border-t border-line bg-bad/10 px-3 py-1 text-[11px] text-bad">{cellError}</div>
      )}
    </div>
  )
}

function CellEditor({
  kind,
  value,
  error,
  onChange,
  onCommit,
  onCancel
}: {
  kind: EditKind
  value: string
  error: boolean
  onChange: (v: string) => void
  onCommit: (v: string) => void
  onCancel: () => void
}): ReactNode {
  const ring = error ? 'ring-bad' : 'ring-accent'
  const common = cn(
    'w-full min-w-[110px] rounded-sm bg-bg-input px-1 font-mono text-[12px] text-ink outline-none ring-1',
    ring
  )

  if (kind === 'bool') {
    return (
      <select
        autoFocus
        className={common}
        value={value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <option value="">null</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }

  const inputType =
    kind === 'datetime' ? 'datetime-local' : kind === 'date' ? 'date' : kind === 'time' ? 'time' : 'text'

  return (
    <input
      autoFocus
      type={inputType}
      step={kind === 'datetime' || kind === 'time' ? 1 : undefined}
      value={value}
      className={common}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value)
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onCommit(value)}
    />
  )
}

function ExportButton({
  label,
  icon,
  open,
  onToggle,
  onPick
}: {
  label: string
  icon: ReactNode
  open: boolean
  onToggle: () => void
  onPick: (fmt: Fmt) => void
}): ReactNode {
  return (
    <div className="relative">
      <button
        className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
        onClick={onToggle}
      >
        {icon}
        {label}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-lg border border-line bg-bg-panel shadow-xl">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover"
              onClick={() => onPick(f.id)}
            >
              {label} as {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
