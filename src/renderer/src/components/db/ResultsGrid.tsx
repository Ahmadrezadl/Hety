import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import {
  Download,
  Copy,
  ClipboardPaste,
  ChevronDown,
  AlertCircle,
  Trash2,
  Undo2,
  UploadCloud,
  RotateCcw,
  Search,
  Lock,
  ArrowUp,
  ArrowDown,
  Eraser,
  Pencil,
  Plus,
  Link2,
  X
} from 'lucide-react'
import type { QueryResult, SchemaColumn, RowChanges, ColumnRef } from '@shared/types'
import { toCsv, toTsv, toMarkdown, copyText, cellString } from '../../lib/format'
import { toast } from '../../lib/toast'
import { Spinner, Modal, Button, cn } from '../../lib/ui'

type Fmt = 'csv' | 'tsv' | 'markdown'
type EditKind = 'datetime' | 'date' | 'time' | 'bool' | 'text'

/** A cell address in grid coordinates (absolute row index, column index). */
interface Cell {
  r: number
  c: number
}
/** A normalised rectangular block of cells. */
interface Rect {
  r1: number
  c1: number
  r2: number
  c2: number
}

const rectOf = (a: Cell, b: Cell): Rect => ({
  r1: Math.min(a.r, b.r),
  r2: Math.max(a.r, b.r),
  c1: Math.min(a.c, b.c),
  c2: Math.max(a.c, b.c)
})
const inRect = (x: Rect, r: number, c: number): boolean =>
  r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

function isJsonType(type: string): boolean {
  return (type || '').toLowerCase().includes('json')
}

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

/** Convert clipboard text into a value for a column. Throws on a type mismatch. */
function parseForColumn(type: string, raw: string): unknown {
  if (raw === '') return null
  const s = raw.trim()
  if (/^null$/i.test(s)) return null
  const kind = inputKind(type)
  if (kind === 'bool') {
    if (/^(true|t|1|yes|y)$/i.test(s)) return true
    if (/^(false|f|0|no|n)$/i.test(s)) return false
    throw new Error(`“${raw}” is not a valid boolean`)
  }
  if (kind === 'datetime') {
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) throw new Error(`“${raw}” is not a valid date/time`)
    return d.toISOString()
  }
  if (kind === 'date' || kind === 'time') return s
  return coerceText(type, raw)
}

/** Split pasted clipboard text into a grid of cells (TSV, as produced by copy). */
function parseClipboardGrid(text: string): string[][] {
  const body = text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return body.split('\n').map((line) => line.split('\t'))
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
  onSort?: (column: string, dir?: 'asc' | 'desc') => void
}): ReactNode {
  const [menu, setMenu] = useState<'copy' | 'save' | null>(null)
  const [search, setSearch] = useState('')
  const [edits, setEdits] = useState<Record<number, Record<number, unknown>>>({})
  const [deleted, setDeleted] = useState<Set<number>>(new Set())
  // Rows being composed for insertion: each is a sparse map of column index -> value.
  // Columns left untouched are omitted from the INSERT so DB defaults apply.
  const [newRows, setNewRows] = useState<Record<number, unknown>[]>([])
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [jsonEdit, setJsonEdit] = useState<{ r: number; c: number } | null>(null)
  const [cellError, setCellError] = useState<string | null>(null)
  const [pushing, setPushing] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)

  // ---- cell selection (single click selects; drag / shift / ctrl extend) ----
  const [ranges, setRanges] = useState<Rect[]>([])
  const [active, setActive] = useState<{ anchor: Cell; focus: Cell } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cell?: Cell } | null>(null)
  const [colMenu, setColMenu] = useState<{ x: number; y: number; column: string } | null>(null)
  const [related, setRelated] = useState<{ column: string; target: ColumnRef; value: unknown } | null>(
    null
  )
  const draggingRef = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const nativePasteAt = useRef(0)

  const clearSelection = (): void => {
    setRanges([])
    setActive(null)
  }

  useEffect(() => {
    setEdits({})
    setDeleted(new Set())
    setNewRows([])
    setEditing(null)
    setCellError(null)
    setPushError(null)
    clearSelection()
  }, [result])

  useEffect(() => {
    const up = (): void => {
      draggingRef.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const columns = result?.columns ?? []

  const meta = useMemo(() => {
    const byName = new Map<string, SchemaColumn>()
    if (editContext) for (const c of editContext.columns) byName.set(c.name, c)
    const pkCols = editContext ? editContext.columns.filter((c) => c.pk).map((c) => c.name) : []
    const hasPk = pkCols.length > 0 && pkCols.every((n) => columns.includes(n))
    return { byName, pkCols, hasPk }
  }, [editContext, columns])

  const editable = !!editContext && meta.hasPk && !locked

  const existingCount = result?.rows.length ?? 0
  const isNewRow = (r: number): boolean => r >= existingCount
  const newIdx = (r: number): number => r - existingCount

  const updatedRowCount = Object.keys(edits).filter(
    (r) => !deleted.has(Number(r)) && Object.keys(edits[Number(r)]).length > 0
  ).length
  // Only count new rows that have at least one value filled in; blank rows are ignored.
  const filledNewCount = newRows.filter((row) => Object.keys(row).length > 0).length
  const totalChanges = updatedRowCount + deleted.size + filledNewCount

  const typeOf = (c: number): string => meta.byName.get(columns[c])?.type ?? 'text'
  const originalValue = (r: number, c: number): unknown => (isNewRow(r) ? null : result!.rows[r][c])
  const displayValue = (r: number, c: number): unknown => {
    if (isNewRow(r)) {
      const row = newRows[newIdx(r)]
      return row && c in row ? row[c] : null
    }
    const e = edits[r]
    if (e && c in e) return e[c]
    return result!.rows[r][c]
  }
  /** Whether a cell carries a pending value (a new-row entry, or an edit to an existing row). */
  const isDirty = (r: number, c: number): boolean => {
    if (isNewRow(r)) {
      const row = newRows[newIdx(r)]
      return !!row && c in row
    }
    return !!edits[r] && c in edits[r]
  }

  const q = search.toLowerCase()
  const rowMatches = (r: number): boolean =>
    !q || columns.some((_, c) => cellString(displayValue(r, c)).toLowerCase().includes(q))

  /** Row indices currently rendered, in visual order (search hides existing rows). */
  const visibleRows = useMemo(() => {
    const out: number[] = []
    for (let r = 0; r < existingCount; r++) if (rowMatches(r)) out.push(r)
    for (let i = 0; i < newRows.length; i++) out.push(existingCount + i)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, q, edits, newRows, existingCount])

  const rects = useMemo(
    () => (active ? [...ranges, rectOf(active.anchor, active.focus)] : ranges),
    [ranges, active]
  )
  const isSelected = (r: number, c: number): boolean => rects.some((x) => inRect(x, r, c))
  const isFocused = (r: number, c: number): boolean => active?.focus.r === r && active?.focus.c === c
  const hasSelection = rects.length > 0

  /** Bounding box across every selected block. */
  const bounds = (): Rect | null => {
    if (!rects.length) return null
    return rects.reduce((a, x) => ({
      r1: Math.min(a.r1, x.r1),
      c1: Math.min(a.c1, x.c1),
      r2: Math.max(a.r2, x.r2),
      c2: Math.max(a.c2, x.c2)
    }))
  }

  /** Selected cells that are actually on screen, in reading order. */
  const selectedCells = (): Cell[] => {
    const b = bounds()
    if (!b) return []
    const out: Cell[] = []
    for (const r of visibleRows) {
      if (r < b.r1 || r > b.r2) continue
      for (let c = b.c1; c <= b.c2; c++) if (isSelected(r, c)) out.push({ r, c })
    }
    return out
  }

  const selectedRowList = (): number[] => {
    const b = bounds()
    if (!b) return []
    return visibleRows.filter((r) => r >= b.r1 && r <= b.r2 && columns.some((_, c) => isSelected(r, c)))
  }

  const selectedCount = useMemo(() => selectedCells().length, [rects, visibleRows, columns.length])

  const selectCell = (r: number, c: number): void => {
    setRanges([])
    setActive({ anchor: { r, c }, focus: { r, c } })
  }
  const selectRow = (r: number, additive = false): void => {
    if (!columns.length) return
    if (additive && active) setRanges((p) => [...p, rectOf(active.anchor, active.focus)])
    else setRanges([])
    setActive({ anchor: { r, c: 0 }, focus: { r, c: columns.length - 1 } })
  }
  const selectAll = (): void => {
    if (!columns.length || !visibleRows.length) return
    setRanges([])
    setActive({
      anchor: { r: visibleRows[0], c: 0 },
      focus: { r: visibleRows[visibleRows.length - 1], c: columns.length - 1 }
    })
  }

  const scrollCellIntoView = (r: number, c: number): void => {
    const el = gridRef.current?.querySelector(`[data-cell="${r}:${c}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const moveFocus = (dr: number, dc: number, extend: boolean): void => {
    if (!active || !visibleRows.length) return
    const from = active.focus
    const vi = visibleRows.indexOf(from.r)
    const nextIdx = clamp((vi < 0 ? 0 : vi) + dr, 0, visibleRows.length - 1)
    const r = visibleRows[nextIdx]
    const c = clamp(from.c + dc, 0, columns.length - 1)
    if (extend) setActive({ anchor: active.anchor, focus: { r, c } })
    else selectCell(r, c)
    scrollCellIntoView(r, c)
  }

  // ---- mouse ----
  const onCellMouseDown = (e: ReactMouseEvent, r: number, c: number): void => {
    if (e.button === 2) {
      // right click keeps an existing multi-cell selection intact
      if (!isSelected(r, c)) selectCell(r, c)
      return
    }
    if (e.button !== 0) return
    gridRef.current?.focus()
    if (e.shiftKey && active) setActive({ anchor: active.anchor, focus: { r, c } })
    else if ((e.ctrlKey || e.metaKey) && active) {
      setRanges((p) => [...p, rectOf(active.anchor, active.focus)])
      setActive({ anchor: { r, c }, focus: { r, c } })
    } else selectCell(r, c)
    draggingRef.current = true
  }

  const onCellMouseEnter = (r: number, c: number): void => {
    if (!draggingRef.current) return
    setActive((a) => (a ? { anchor: a.anchor, focus: { r, c } } : a))
  }

  /** `cell` records which cell was clicked, which can differ from the focused
   *  one when the right click lands inside an existing multi-cell selection. */
  const openCtxMenu = (e: ReactMouseEvent, cell?: Cell): void => {
    e.preventDefault()
    gridRef.current?.focus()
    setColMenu(null)
    setCtxMenu({ x: e.clientX, y: e.clientY, cell })
  }

  const openColMenu = (e: ReactMouseEvent, column: string): void => {
    if (!onSort) return
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu(null)
    setColMenu({ x: e.clientX, y: e.clientY, column })
  }

  // ---- clipboard ----
  /** Selected cells as TSV; unselected cells inside the bounding box stay blank. */
  const selectionText = (): string => {
    const b = bounds()
    if (!b) return ''
    const lines: string[] = []
    for (const r of visibleRows) {
      if (r < b.r1 || r > b.r2) continue
      const cells: string[] = []
      for (let c = b.c1; c <= b.c2; c++)
        cells.push(isSelected(r, c) ? cellString(displayValue(r, c)) : '')
      lines.push(cells.join('\t'))
    }
    return lines.join('\n')
  }

  const copySelection = async (): Promise<void> => {
    if (!result) return
    const text = hasSelection ? selectionText() : toTsv(result)
    if (!text) return
    await copyText(text)
    toast.success(hasSelection ? `Copied ${selectedCount} cell(s)` : 'Copied all rows')
  }

  /** Write `raw` into a cell, respecting its column type. Throws on a mismatch. */
  const setCellFromText = (r: number, c: number, raw: string): void => {
    applyCellEdit(r, c, parseForColumn(typeOf(c), raw))
  }

  const applyPastedText = (text: string): void => {
    if (!editable) {
      toast.error(
        locked ? 'This connection is locked — unlock it to paste.' : 'This result is read-only.'
      )
      return
    }
    const b = bounds()
    if (!b || !text) return
    const grid = parseClipboardGrid(text)
    const single = grid.length === 1 && grid[0].length === 1
    try {
      if (single) {
        // one value fans out into every selected cell
        const raw = grid[0][0]
        const targets = selectedCells().filter((t) => !deleted.has(t.r))
        for (const t of targets) setCellFromText(t.r, t.c, raw)
        setCellError(null)
        toast.success(`Pasted into ${targets.length} cell(s)`)
        return
      }
      const startIdx = visibleRows.indexOf(b.r1)
      if (startIdx < 0) return
      let written = 0
      for (let gy = 0; gy < grid.length; gy++) {
        const r = visibleRows[startIdx + gy]
        if (r === undefined) break
        if (deleted.has(r)) continue
        for (let gx = 0; gx < grid[gy].length; gx++) {
          const c = b.c1 + gx
          if (c >= columns.length) break
          setCellFromText(r, c, grid[gy][gx])
          written++
        }
      }
      setCellError(null)
      toast.success(`Pasted into ${written} cell(s)`)
    } catch (e) {
      setCellError((e as Error).message)
      toast.error((e as Error).message)
    }
  }

  /** Ctrl+V path: read the clipboard directly, unless a native paste already ran. */
  const pasteFromClipboard = (): void => {
    const stamp = nativePasteAt.current
    setTimeout(() => {
      if (nativePasteAt.current !== stamp) return // the DOM paste event handled it
      const clip = navigator.clipboard
      if (!clip?.readText) {
        toast.error('Clipboard is not available')
        return
      }
      clip
        .readText()
        .then((text) => text && applyPastedText(text))
        .catch(() => toast.error('Clipboard is not available'))
    }, 0)
  }

  const onGridPaste = (e: ReactClipboardEvent): void => {
    if (editing || jsonEdit) return
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    e.preventDefault()
    nativePasteAt.current = Date.now()
    applyPastedText(text)
  }

  // ---- edits ----
  /** Store an edit for a cell (clearing it when the value matches the original). */
  const applyCellEdit = (r: number, c: number, value: unknown): void => {
    if (isNewRow(r)) {
      const idx = newIdx(r)
      setNewRows((prev) => {
        const next = prev.slice()
        next[idx] = { ...(next[idx] ?? {}), [c]: value }
        return next
      })
      return
    }
    const original = result!.rows[r][c]
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
  }

  const beginEdit = (r: number, c: number, seed?: string): void => {
    if (!editable || deleted.has(r)) return
    if (isJsonType(typeOf(c))) {
      setJsonEdit({ r, c })
      return
    }
    const kind = inputKind(typeOf(c))
    if (seed !== undefined && kind === 'text') {
      setEditing({ r, c })
      setEditingValue(seed)
      setCellError(null)
      return
    }
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
    const original = originalValue(r, c)
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

    applyCellEdit(r, c, value)
    setEditing(null)
    setCellError(null)
    gridRef.current?.focus()
  }

  const setSelectionNull = (): void => {
    if (!editable) return
    const targets = selectedCells().filter((t) => !deleted.has(t.r))
    for (const t of targets) applyCellEdit(t.r, t.c, null)
  }

  const toggleDelete = (r: number): void =>
    setDeleted((prev) => {
      const n = new Set(prev)
      n.has(r) ? n.delete(r) : n.add(r)
      return n
    })

  /** Mark every row touched by the selection for deletion (or undo when all are marked). */
  const deleteSelectedRows = (): void => {
    if (!editable) {
      if (editContext) toast.error(locked ? 'Connection is locked.' : 'This result is read-only.')
      return
    }
    const rows = selectedRowList()
    if (!rows.length) return
    const existing = rows.filter((r) => !isNewRow(r))
    const pending = rows.filter(isNewRow).map(newIdx)
    if (existing.length) {
      const allMarked = existing.every((r) => deleted.has(r))
      setDeleted((prev) => {
        const n = new Set(prev)
        for (const r of existing) (allMarked ? n.delete(r) : n.add(r))
        return n
      })
    }
    if (pending.length) {
      // dropping unsaved rows shifts indices, so the selection is no longer meaningful
      setNewRows((prev) => prev.filter((_, i) => !pending.includes(i)))
      clearSelection()
    }
    setEditing(null)
  }

  const addNewRow = (): void => setNewRows((prev) => [...prev, {}])
  const removeNewRow = (idx: number): void => {
    setEditing(null)
    clearSelection()
    setNewRows((prev) => prev.filter((_, i) => i !== idx))
  }

  const revert = (): void => {
    setEdits({})
    setDeleted(new Set())
    setNewRows([])
    setEditing(null)
    setCellError(null)
    setPushError(null)
  }

  // ---- keyboard ----
  const onGridKeyDown = (e: ReactKeyboardEvent): void => {
    if (editing || jsonEdit) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key

    if (mod && key.toLowerCase() === 'c') {
      e.preventDefault()
      void copySelection()
      return
    }
    if (mod && key.toLowerCase() === 'v') {
      pasteFromClipboard() // no preventDefault: a native paste event may beat us to it
      return
    }
    if (mod && key.toLowerCase() === 'a') {
      e.preventDefault()
      selectAll()
      return
    }
    if (key === 'Escape') {
      clearSelection()
      setCtxMenu(null)
      setColMenu(null)
      return
    }
    if (!active) return

    switch (key) {
      case 'ArrowUp':
        e.preventDefault()
        moveFocus(-1, 0, e.shiftKey)
        return
      case 'ArrowDown':
        e.preventDefault()
        moveFocus(1, 0, e.shiftKey)
        return
      case 'ArrowLeft':
        e.preventDefault()
        moveFocus(0, -1, e.shiftKey)
        return
      case 'ArrowRight':
      case 'Tab':
        e.preventDefault()
        moveFocus(0, key === 'Tab' && e.shiftKey ? -1 : 1, key === 'ArrowRight' && e.shiftKey)
        return
      case 'PageUp':
        e.preventDefault()
        moveFocus(-20, 0, e.shiftKey)
        return
      case 'PageDown':
        e.preventDefault()
        moveFocus(20, 0, e.shiftKey)
        return
      case 'Home':
        e.preventDefault()
        moveFocus(0, -columns.length, e.shiftKey)
        return
      case 'End':
        e.preventDefault()
        moveFocus(0, columns.length, e.shiftKey)
        return
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        deleteSelectedRows()
        return
      case 'Enter':
      case 'F2':
        e.preventDefault()
        beginEdit(active.focus.r, active.focus.c)
        return
    }

    // start editing on the first printable character, like a spreadsheet
    if (!mod && !e.altKey && key.length === 1) {
      e.preventDefault()
      beginEdit(active.focus.r, active.focus.c, key)
    }
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
      if (deleted.has(r) || isNewRow(r)) continue
      const cols = edits[r]
      const set: Record<string, unknown> = {}
      for (const cStr of Object.keys(cols)) set[columns[Number(cStr)]] = cols[Number(cStr)]
      if (Object.keys(set).length) updates.push({ where: pkWhere(r), set })
    }
    const deletes: RowChanges['deletes'] = [...deleted]
      .filter((r) => !isNewRow(r))
      .map((r) => ({ where: pkWhere(r) }))
    const inserts: RowChanges['inserts'] = newRows
      .map((row) => {
        const values: Record<string, unknown> = {}
        for (const cStr of Object.keys(row)) values[columns[Number(cStr)]] = row[Number(cStr)]
        return { values }
      })
      .filter((ins) => Object.keys(ins.values).length > 0)
    const res = await window.api.db.applyChanges(editContext.connectionId, editContext.table, {
      inserts,
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

  /** One data cell — shared by existing rows and pending inserts. */
  const renderCell = (r: number, c: number, opts: { isDel: boolean; pending: boolean }): ReactNode => {
    const { isDel, pending } = opts
    const editingHere = editing?.r === r && editing?.c === c
    const provided = isDirty(r, c)
    const v = displayValue(r, c)
    const kind = inputKind(typeOf(c))
    const selected = isSelected(r, c)
    const focused = isFocused(r, c)
    const showsDefault = pending && !provided

    return (
      <td
        key={c}
        data-cell={`${r}:${c}`}
        className={cn(
          'max-w-[420px] truncate border-b border-r border-line/60 px-3 py-1 font-mono',
          selected ? 'bg-accent/25' : provided && !isDel ? 'bg-warn/20' : undefined,
          v === null && !editingHere && !showsDefault && 'italic text-ink-faint',
          isDel && 'line-through opacity-60',
          editable && !isDel ? 'cursor-cell' : 'cursor-default'
        )}
        style={focused && !editingHere ? { boxShadow: 'inset 0 0 0 2px #6d8cff' } : undefined}
        title={
          showsDefault ? 'Click to select · double-click to set · blank uses the DB default' : cellString(v)
        }
        onMouseDown={(e) => onCellMouseDown(e, r, c)}
        onMouseEnter={() => onCellMouseEnter(r, c)}
        onDoubleClick={() => beginEdit(r, c)}
        onContextMenu={(e) => openCtxMenu(e, { r, c })}
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
              gridRef.current?.focus()
            }}
          />
        ) : showsDefault ? (
          <span className="italic text-ink-faint/60">default</span>
        ) : v === null ? (
          'null'
        ) : (
          cellString(v)
        )}
      </td>
    )
  }

  const menuItems = (): MenuEntry[] => {
    const rows = selectedRowList()
    const anyMarked = rows.some((r) => !isNewRow(r) && deleted.has(r))

    // Foreign-key lookup for the clicked cell (column metadata only exists when
    // the console was opened from a table, which is also where the connection is).
    const cell = ctxMenu?.cell ?? active?.focus
    const fkColumn = cell ? columns[cell.c] : undefined
    const fk = fkColumn ? meta.byName.get(fkColumn)?.ref : undefined
    const fkValue = cell && fk ? displayValue(cell.r, cell.c) : null
    const fkItems: MenuEntry[] =
      fk && fkColumn && editContext
        ? [
            {
              label: 'See related row',
              hint: `${fk.table}.${fk.column}`,
              icon: <Link2 size={13} />,
              disabled: fkValue === null || fkValue === undefined,
              onClick: () => setRelated({ column: fkColumn, target: fk, value: fkValue })
            },
            { separator: true }
          ]
        : []

    return [
      ...fkItems,
      {
        label: 'Copy',
        hint: 'Ctrl+C',
        icon: <Copy size={13} />,
        onClick: () => void copySelection()
      },
      {
        label: 'Paste',
        hint: 'Ctrl+V',
        icon: <ClipboardPaste size={13} />,
        disabled: !editable,
        onClick: pasteFromClipboard
      },
      {
        label: 'Edit cell',
        hint: 'Enter',
        icon: <Pencil size={13} />,
        disabled: !editable || !active,
        onClick: () => active && beginEdit(active.focus.r, active.focus.c)
      },
      { separator: true },
      {
        label: 'Set NULL',
        icon: <Eraser size={13} />,
        disabled: !editable,
        onClick: setSelectionNull
      },
      {
        label: anyMarked ? `Restore row${rows.length > 1 ? 's' : ''}` : `Delete row${rows.length > 1 ? 's' : ''}`,
        hint: 'Del',
        icon: anyMarked ? <Undo2 size={13} /> : <Trash2 size={13} />,
        danger: !anyMarked,
        disabled: !editable || !rows.length,
        onClick: deleteSelectedRows
      },
      {
        label: 'Add row',
        icon: <Plus size={13} />,
        disabled: !editable,
        onClick: addNewRow
      }
    ]
  }

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

        {selectedCount > 1 && <span className="text-accent">· {selectedCount} cells</span>}
        {deleted.size > 0 && (
          <span className="text-bad">
            · {deleted.size} row{deleted.size === 1 ? '' : 's'} to delete
          </span>
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

          {editable && (
            <button
              className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
              onClick={addNewRow}
              disabled={pushing}
              title="Add a new row to insert"
            >
              <Plus size={12} /> Add row
            </button>
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

      <div
        ref={gridRef}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto outline-none"
        onKeyDown={onGridKeyDown}
        onPaste={onGridPaste}
      >
        {result && result.columns.length > 0 ? (
          <table className="border-collapse text-[12px]">
            <thead className="sticky top-0 z-10">
              <tr>
                <th
                  className="cursor-pointer border-b border-r border-line bg-bg-elevated px-2 py-1.5 text-right font-mono text-[10px] text-ink-faint hover:text-ink"
                  title="Select all cells (Ctrl+A)"
                  onClick={selectAll}
                >
                  #
                </th>
                {columns.map((c, i) => {
                  const col = meta.byName.get(c)
                  const sorted = sort && sort.column === c ? sort.dir : null
                  const fk = col?.ref
                  const fkText = fk
                    ? ` · → ${fk.schema ? `${fk.schema}.` : ''}${fk.table}.${fk.column}`
                    : ''
                  return (
                    <th
                      key={i}
                      className={cn(
                        'whitespace-nowrap border-b border-r border-line bg-bg-elevated px-3 py-1.5 text-left font-bold text-ink-soft',
                        onSort && 'cursor-pointer select-none hover:text-ink'
                      )}
                      title={
                        onSort
                          ? `${col ? `${c} · ${col.type}${col.pk ? ' · PK' : ''}${fkText}` : c} · click to sort`
                          : col
                            ? `${c} · ${col.type}${col.pk ? ' · PK' : ''}${fkText}`
                            : c
                      }
                      onClick={onSort ? () => onSort(c) : undefined}
                      onContextMenu={(e) => openColMenu(e, c)}
                    >
                      <span className="inline-flex items-center gap-1">
                        {col?.pk && <span className="text-warn">🔑</span>}
                        {fk && <Link2 size={11} className="text-accent" />}
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
                    <td
                      className={cn(
                        'group/cell cursor-pointer border-b border-r border-line/60 px-1 py-1 text-right font-mono text-[10px] text-ink-faint',
                        isDel ? 'bg-bad/25 text-bad' : 'bg-bg-panel'
                      )}
                      onMouseDown={(e) => {
                        if (e.button === 0) {
                          gridRef.current?.focus()
                          selectRow(r, e.ctrlKey || e.metaKey)
                        } else if (e.button === 2 && !selectedRowList().includes(r)) selectRow(r)
                      }}
                      onContextMenu={openCtxMenu}
                    >
                      {editable ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            title={isDel ? 'Undo delete' : 'Delete row'}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => toggleDelete(r)}
                            className={cn(isDel ? 'text-bad' : 'text-ink-faint hover:text-bad')}
                          >
                            {isDel ? (
                              <Undo2 size={11} />
                            ) : (
                              <Trash2 size={11} className="opacity-0 group-hover/cell:opacity-100" />
                            )}
                          </button>
                          <span>{r + 1}</span>
                        </span>
                      ) : (
                        r + 1
                      )}
                    </td>
                    {columns.map((_c, c) => renderCell(r, c, { isDel, pending: false }))}
                  </tr>
                )
              })}
              {newRows.map((_nr, idx) => {
                const r = existingCount + idx
                return (
                  <tr key={`new-${idx}`} className="bg-ok/10">
                    <td
                      className="group/cell cursor-pointer border-b border-r border-line/60 bg-bg-panel px-1 py-1 text-right font-mono text-[10px] text-ink-faint"
                      onMouseDown={(e) => e.button === 0 && selectRow(r, e.ctrlKey || e.metaKey)}
                      onContextMenu={openCtxMenu}
                    >
                      <span className="inline-flex items-center gap-1">
                        <button
                          title="Remove new row"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => removeNewRow(idx)}
                        >
                          <X size={11} className="text-ink-faint group-hover/cell:text-bad" />
                        </button>
                        <span className="text-ok">+</span>
                      </span>
                    </td>
                    {columns.map((_c, c) => renderCell(r, c, { isDel: false, pending: true }))}
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

      {ctxMenu && (
        <GridMenu x={ctxMenu.x} y={ctxMenu.y} items={menuItems()} onClose={() => setCtxMenu(null)} />
      )}

      {colMenu && onSort && (
        <GridMenu
          x={colMenu.x}
          y={colMenu.y}
          items={[
            {
              label: 'Sort ascending',
              icon: <ArrowUp size={14} />,
              onClick: () => {
                onSort(colMenu.column, 'asc')
                setColMenu(null)
              }
            },
            {
              label: 'Sort descending',
              icon: <ArrowDown size={14} />,
              onClick: () => {
                onSort(colMenu.column, 'desc')
                setColMenu(null)
              }
            }
          ]}
          onClose={() => setColMenu(null)}
        />
      )}

      {related && editContext && (
        <RelatedRowModal
          connectionId={editContext.connectionId}
          column={related.column}
          target={related.target}
          value={related.value}
          onClose={() => setRelated(null)}
        />
      )}

      {jsonEdit && (
        <JsonEditorModal
          column={columns[jsonEdit.c]}
          initial={displayValue(jsonEdit.r, jsonEdit.c)}
          onClose={() => setJsonEdit(null)}
          onSave={(compact) => {
            applyCellEdit(jsonEdit.r, jsonEdit.c, compact)
            setJsonEdit(null)
          }}
        />
      )}
    </div>
  )
}

type MenuEntry =
  | { separator: true }
  | {
      separator?: false
      label: string
      hint?: string
      icon?: ReactNode
      danger?: boolean
      disabled?: boolean
      onClick: () => void
    }

function GridMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}): ReactNode {
  const width = 220
  const left = Math.min(x, window.innerWidth - width - 8)
  const top = Math.min(y, window.innerHeight - items.length * 28 - 16)
  return (
    <>
      <div
        className="fixed inset-0 z-[95]"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="fixed z-[100] overflow-hidden rounded-lg border border-line bg-bg-panel py-1 shadow-2xl"
        style={{ left, top: Math.max(8, top), width }}
      >
        {items.map((it, i) =>
          it.separator ? (
            <div key={i} className="my-1 border-t border-line" />
          ) : (
            <button
              key={i}
              disabled={it.disabled}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover disabled:opacity-35 disabled:hover:bg-transparent',
                it.danger ? 'text-bad' : 'text-ink'
              )}
              onClick={() => {
                it.onClick()
                onClose()
              }}
            >
              <span className="w-4 shrink-0 text-ink-faint">{it.icon}</span>
              <span className="flex-1 whitespace-nowrap">{it.label}</span>
              {it.hint && (
                <span className="max-w-[84px] truncate text-[10px] text-ink-faint">{it.hint}</span>
              )}
            </button>
          )
        )}
      </div>
    </>
  )
}

/** Shows the row a foreign-key cell points at, one field per line. */
function RelatedRowModal({
  connectionId,
  column,
  target,
  value,
  onClose
}: {
  connectionId: string
  column: string
  target: ColumnRef
  value: unknown
  onClose: () => void
}): ReactNode {
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const qualified = target.schema ? `${target.schema}.${target.table}` : target.table

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setResult(null)
    void window.api.db.relatedRows(connectionId, target, value, 20).then((r) => {
      if (cancelled) return
      setLoading(false)
      if (r.ok && r.data) setResult(r.data)
      else setError(r.ok ? 'No data' : r.error)
    })
    return () => {
      cancelled = true
    }
  }, [connectionId, target, value])

  const copyRow = async (row: unknown[]): Promise<void> => {
    if (!result) return
    await copyText(result.columns.map((c, i) => `${c}\t${cellString(row[i])}`).join('\n'))
    toast.success('Row copied')
  }

  return (
    <Modal title={`Related row · ${qualified}`} width={620} onClose={onClose}>
      <div className="space-y-3">
        <div className="font-mono text-[11px] text-ink-faint">
          {column} → {qualified}.{target.column} = {cellString(value)}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-ink-soft">
            <Spinner /> Loading…
          </div>
        ) : error ? (
          <div className="rounded-md bg-bad/10 px-3 py-2 text-xs text-bad">{error}</div>
        ) : !result || result.rowCount === 0 ? (
          <div className="rounded-md bg-bg-elevated px-3 py-2 text-xs text-ink-faint">
            No matching row in {qualified}.
          </div>
        ) : (
          <div className="max-h-[420px] space-y-3 overflow-auto">
            {result.rows.map((row, i) => (
              <div key={i} className="overflow-hidden rounded-md border border-line">
                {result.rows.length > 1 && (
                  <div className="border-b border-line bg-bg-elevated px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                    Row {i + 1} of {result.rows.length}
                  </div>
                )}
                <table className="w-full text-[12px]">
                  <tbody>
                    {result.columns.map((c, ci) => (
                      <tr key={c} className="border-b border-line/60 last:border-b-0">
                        <td className="w-[35%] whitespace-nowrap bg-bg-panel px-3 py-1 align-top font-semibold text-ink-soft">
                          {c}
                        </td>
                        <td className="break-all px-3 py-1 font-mono">
                          {row[ci] === null ? (
                            <span className="italic text-ink-faint">null</span>
                          ) : (
                            cellString(row[ci])
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex justify-end border-t border-line bg-bg-panel px-2 py-1">
                  <button
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-bg-hover hover:text-ink"
                    onClick={() => void copyRow(row)}
                  >
                    <Copy size={11} /> Copy
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function JsonEditorModal({
  column,
  initial,
  onClose,
  onSave
}: {
  column: string
  initial: unknown
  onClose: () => void
  onSave: (compact: string | null) => void
}): ReactNode {
  const initialText = useMemo(() => {
    if (initial === null || initial === undefined || initial === '') return ''
    const s = typeof initial === 'string' ? initial : JSON.stringify(initial)
    try {
      return JSON.stringify(JSON.parse(s), null, 2)
    } catch {
      return s
    }
  }, [initial])

  const [text, setText] = useState(initialText)
  const [error, setError] = useState<string | null>(null)

  const beautify = (): void => {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const save = (): void => {
    const trimmed = text.trim()
    if (!trimmed) {
      onSave(null)
      return
    }
    try {
      onSave(JSON.stringify(JSON.parse(trimmed)))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Modal title={`Edit JSON · ${column}`} width={680} onClose={onClose}>
      <div className="space-y-3">
        <textarea
          autoFocus
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          placeholder="null"
          className="field-input h-[360px] w-full resize-none whitespace-pre font-mono text-[12px] leading-[1.5]"
        />
        {error ? (
          <div className="rounded-md bg-bad/10 px-3 py-2 text-xs text-bad">Invalid JSON: {error}</div>
        ) : (
          <div className="text-[11px] text-ink-faint">
            Empty = NULL. Changes apply locally; use the grid’s <strong>Push</strong> button to write
            them to the database.
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={beautify}>
            Beautify
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </div>
      </div>
    </Modal>
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
        onMouseDown={(e) => e.stopPropagation()}
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
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value)
        else if (e.key === 'Escape') onCancel()
        else if (e.key === 'Tab') onCommit(value)
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
