import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { Compartment } from '@codemirror/state'
import { autocompletion, startCompletion } from '@codemirror/autocomplete'
import { sql, type SQLConfig } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { Play, Save } from 'lucide-react'
import type { DbSchema, QueryResult, SchemaColumn } from '@shared/types'
import type { DatabaseKind } from '@shared/databases'
import ResultsGrid from './ResultsGrid'
import { Modal, Button, Input } from '../../lib/ui'
import { ResizeHandle, usePersistedSize } from '../../lib/resize'
import { buildSqlNamespace, defaultSchemaFor, sqlDialectFor } from '../../lib/sqlCompletion'
import { buildTableQuery, quoteIdent } from '@shared/sql'

export type SortState = { column: string; dir: 'asc' | 'desc' } | null

export interface EditTable {
  /** fully quoted `schema.table`, used when writing changes back. */
  table: string
  /** schema namespace the table lives in. */
  schema?: string
  /** bare table name, completed without a prefix inside this console. */
  name?: string
  columns: SchemaColumn[]
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
  kind,
  dbName,
  schema,
  initialSql,
  autorun,
  editTable,
  locked,
  onSave,
  onExecuted
}: {
  connectionId: string | null
  connected: boolean
  kind?: DatabaseKind | string
  dbName?: string
  schema?: DbSchema
  initialSql?: string
  autorun?: boolean
  editTable?: EditTable
  locked?: boolean
  onSave: (name: string, sql: string) => void
  /** Called after every run, successful or not, so it can be logged to history. */
  onExecuted?: (run: { sql: string; elapsedMs: number; rowCount?: number; error?: string }) => void
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langRef = useRef(new Compartment())
  const runRef = useRef<() => void>(() => undefined)
  const connRef = useRef(connectionId)
  connRef.current = connectionId
  const onExecutedRef = useRef(onExecuted)
  onExecutedRef.current = onExecuted

  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [sort, setSort] = useState<SortState>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const tableView = !!editTable?.schema && !!editTable.name
  const [whereClause, setWhereClause] = useState('')
  const [orderByClause, setOrderByClause] = useState('')
  const [editorH, setEditorH] = usePersistedSize(
    tableView ? 'sql.editor.table' : 'sql.editor',
    tableView ? 120 : 280,
    100,
    900
  )

  const tableSql = (): string => {
    if (!tableView || !kind || !editTable?.schema || !editTable.name) return ''
    return buildTableQuery(kind, editTable.schema, editTable.name, {
      where: whereClause,
      orderBy: orderByClause
    })
  }

  const syncEditor = (sql: string): void => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql } })
  }

  const execute = async (stmt: string): Promise<void> => {
    if (!connRef.current) return
    const text = stmt.trim()
    if (!text) return
    setRunning(true)
    setError(null)
    const startedAt = Date.now()
    const r = await window.api.db.query(connRef.current, text)
    setRunning(false)
    if (r.ok && r.data) {
      setResult(r.data)
      setError(null)
    } else {
      setError(r.ok ? 'No data' : r.error)
    }
    // The driver times the statement itself; wall time is the fallback for
    // failures, which come back without a result.
    const failure = r.ok && r.data ? undefined : r.ok ? 'No data' : r.error
    onExecutedRef.current?.({
      sql: text,
      elapsedMs: r.ok && r.data ? r.data.elapsedMs : Date.now() - startedAt,
      rowCount: r.ok && r.data ? r.data.rowCount : undefined,
      error: failure
    })
  }

  const run = (): void => {
    const view = viewRef.current
    if (!view) return
    let text: string
    if (tableView) {
      text = tableSql()
      syncEditor(text)
    } else {
      const sel = view.state.selection.main
      text = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to)
    }
    setSort(null)
    void execute(text)
  }
  runRef.current = run

  // Re-run the current statement sorted by a clicked column, rewriting the SQL.
  const sortBy = (column: string, forceDir?: 'asc' | 'desc'): void => {
    if (tableView && kind) {
      let dir: 'asc' | 'desc' | null
      if (forceDir) dir = forceDir
      else if (!sort || sort.column !== column) dir = 'asc'
      else if (sort.dir === 'asc') dir = 'desc'
      else dir = null
      const col = quoteIdent(kind, column)
      const nextOrder = dir ? `${col} ${dir.toUpperCase()}` : ''
      setOrderByClause(nextOrder)
      setSort(dir ? { column, dir } : null)
      const sql = buildTableQuery(kind, editTable!.schema!, editTable!.name!, {
        where: whereClause,
        orderBy: nextOrder
      })
      syncEditor(sql)
      void execute(sql)
      return
    }
    const view = viewRef.current
    if (!view) return
    let dir: 'asc' | 'desc' | null
    if (forceDir) dir = forceDir
    else if (!sort || sort.column !== column) dir = 'asc'
    else if (sort.dir === 'asc') dir = 'desc'
    else dir = null
    const next = applySort(view.state.doc.toString(), column, dir)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    setSort(dir ? { column, dir } : null)
    void execute(next)
  }

  // Completion sources: schema-aware tables/columns for the connected dialect.
  const sqlConfig = (): SQLConfig => ({
    dialect: sqlDialectFor(kind),
    schema: buildSqlNamespace(schema),
    defaultSchema: defaultSchemaFor(kind, dbName, schema),
    defaultTable: editTable?.name,
    upperCaseKeywords: true
  })

  // create editor once
  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      doc: initialSql ?? '',
      extensions: [
        basicSetup,
        oneDark,
        langRef.current.of(sql(sqlConfig())),
        autocompletion({ activateOnTyping: true, icons: true, defaultKeymap: true }),
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              runRef.current()
              return true
            }
          },
          // JetBrains-style explicit completion trigger.
          { key: 'Ctrl-Space', preventDefault: true, run: startCompletion },
          { key: 'Alt-Space', preventDefault: true, run: startCompletion }
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

  // reconfigure language when the schema arrives or the connection changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: langRef.current.reconfigure(sql(sqlConfig())) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, kind, dbName, editTable?.name])

  const openSave = (): void => {
    const view = viewRef.current
    if (!view || !view.state.doc.toString().trim()) return
    setSaveName('')
    setSaveOpen(true)
  }

  const runTableFilters = (): void => {
    if (!tableView) return
    const sql = tableSql()
    syncEditor(sql)
    setSort(null)
    void execute(sql)
  }

  const filterKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      runTableFilters()
    }
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
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-bg-panel px-3 py-1.5">
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
        {tableView && (
          <>
            <span className="ml-1 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Where</span>
            <input
              className="min-w-[120px] flex-1 rounded-md bg-bg-input px-2 py-1 text-xs outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-accent"
              placeholder="id = 1"
              value={whereClause}
              onChange={(e) => setWhereClause(e.target.value)}
              onKeyDown={filterKeyDown}
              disabled={!connected}
            />
            <span className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Order by</span>
            <input
              className="min-w-[120px] flex-1 rounded-md bg-bg-input px-2 py-1 text-xs outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-accent"
              placeholder="created_at DESC"
              value={orderByClause}
              onChange={(e) => setOrderByClause(e.target.value)}
              onKeyDown={filterKeyDown}
              disabled={!connected}
            />
          </>
        )}
        {!connected && <span className="text-[11px] text-ink-faint">Not connected</span>}
      </div>
      <div
        ref={hostRef}
        style={{ height: editorH }}
        className="min-h-0 shrink-0 overflow-hidden border-b border-line"
      />
      <ResizeHandle axis="y" size={editorH} onResize={setEditorH} />
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
