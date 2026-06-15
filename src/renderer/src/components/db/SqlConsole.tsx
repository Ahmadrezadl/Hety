import { useEffect, useRef, useState, type ReactNode } from 'react'
import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { Compartment } from '@codemirror/state'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { Play, Save } from 'lucide-react'
import type { DbSchema, QueryResult, SchemaColumn } from '@shared/types'
import ResultsGrid from './ResultsGrid'
import { Modal, Button, Input } from '../../lib/ui'

export type SortState = { column: string; dir: 'asc' | 'desc' } | null

function buildSchema(schema?: DbSchema): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!schema) return out
  for (const ns of schema.schemas) {
    for (const t of [...ns.tables, ...ns.views]) {
      out[t.name] = t.columns.map((c) => c.name)
    }
  }
  return out
}

/** Rewrite a SELECT to sort by `column` (or remove sorting when dir is null),
 *  preserving any trailing LIMIT/OFFSET. */
function applySort(sql: string, column: string, dir: 'asc' | 'desc' | null): string {
  let s = sql.trim()
  let semi = ''
  while (s.endsWith(';')) {
    s = s.slice(0, -1).trimEnd()
    semi = ';'
  }
  let tail = ''
  const tailRe = /\s+(limit\s+\d+(\s+offset\s+\d+)?|offset\s+\d+(\s+limit\s+\d+)?)\s*$/i
  const m = s.match(tailRe)
  if (m && m.index !== undefined) {
    tail = ' ' + m[0].trim()
    s = s.slice(0, m.index).trimEnd()
  }
  s = s.replace(/\s+order\s+by\s+[\s\S]+$/i, '').trimEnd()
  const col = `"${column.replace(/"/g, '""')}"`
  const order = dir ? ` ORDER BY ${col} ${dir.toUpperCase()}` : ''
  return `${s}${order}${tail}${semi}`
}

export default function SqlConsole({
  connectionId,
  connected,
  schema,
  initialSql,
  autorun,
  editTable,
  locked,
  onSave
}: {
  connectionId: string | null
  connected: boolean
  schema?: DbSchema
  initialSql?: string
  autorun?: boolean
  editTable?: { table: string; columns: SchemaColumn[] }
  locked?: boolean
  onSave: (name: string, sql: string) => void
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langRef = useRef(new Compartment())
  const runRef = useRef<() => void>(() => undefined)
  const connRef = useRef(connectionId)
  connRef.current = connectionId

  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [sort, setSort] = useState<SortState>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')

  const execute = async (stmt: string): Promise<void> => {
    if (!connRef.current) return
    const text = stmt.trim()
    if (!text) return
    setRunning(true)
    setError(null)
    const r = await window.api.db.query(connRef.current, text)
    setRunning(false)
    if (r.ok && r.data) {
      setResult(r.data)
      setError(null)
    } else {
      setError(r.ok ? 'No data' : r.error)
    }
  }

  const run = (): void => {
    const view = viewRef.current
    if (!view) return
    const sel = view.state.selection.main
    const text = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to)
    setSort(null) // a manual run clears any column-sort indicator
    void execute(text)
  }
  runRef.current = run

  // Re-run the current statement sorted by a clicked column, rewriting the SQL.
  const sortBy = (column: string): void => {
    const view = viewRef.current
    if (!view) return
    let dir: 'asc' | 'desc' | null
    if (!sort || sort.column !== column) dir = 'asc'
    else if (sort.dir === 'asc') dir = 'desc'
    else dir = null
    const next = applySort(view.state.doc.toString(), column, dir)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    setSort(dir ? { column, dir } : null)
    void execute(next)
  }

  // create editor once
  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      doc: initialSql ?? '',
      extensions: [
        basicSetup,
        oneDark,
        langRef.current.of(
          sql({ dialect: PostgreSQL, schema: buildSchema(schema), upperCaseKeywords: true })
        ),
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              runRef.current()
              return true
            }
          }
        ]),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: '#0e0f13' },
          '.cm-gutters': { backgroundColor: '#0e0f13', border: 'none' }
        })
      ]
    })
    viewRef.current = view
    view.focus()
    if (autorun && initialSql && connected) {
      // defer to allow connection ready
      setTimeout(() => runRef.current(), 50)
    }
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // reconfigure language when schema arrives
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: langRef.current.reconfigure(
        sql({ dialect: PostgreSQL, schema: buildSchema(schema), upperCaseKeywords: true })
      )
    })
  }, [schema])

  const openSave = (): void => {
    const view = viewRef.current
    if (!view || !view.state.doc.toString().trim()) return
    setSaveName('')
    setSaveOpen(true)
  }

  const confirmSave = (): void => {
    const view = viewRef.current
    const stmt = view?.state.doc.toString().trim()
    const name = saveName.trim()
    if (view && stmt && name) onSave(name, stmt)
    setSaveOpen(false)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-bg-panel px-3 py-1.5">
        <button
          className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
          disabled={!connected}
          onClick={run}
          title="Run (Ctrl+Enter)"
        >
          <Play size={12} /> Run
        </button>
        <button
          className="flex items-center gap-1.5 rounded-md border border-line bg-bg-elevated px-2.5 py-1 text-[12px] font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
          onClick={openSave}
        >
          <Save size={12} /> Save
        </button>
        {!connected && <span className="text-[11px] text-ink-faint">Not connected</span>}
      </div>
      <div ref={hostRef} className="min-h-0 basis-[42%] overflow-hidden border-b border-line" />
      <div className="min-h-0 flex-1">
        <ResultsGrid
          result={result}
          error={error}
          running={running}
          editContext={
            editTable && connectionId
              ? { connectionId, table: editTable.table, columns: editTable.columns }
              : undefined
          }
          locked={locked}
          onReload={run}
          sort={sort}
          onSort={sortBy}
        />
      </div>

      {saveOpen && (
        <Modal title="Save query" width={420} onClose={() => setSaveOpen(false)}>
          <div className="space-y-3">
            <Input
              autoFocus
              placeholder="Query name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmSave()
                else if (e.key === 'Escape') setSaveOpen(false)
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setSaveOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!saveName.trim()} onClick={confirmSave}>
                Save
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
