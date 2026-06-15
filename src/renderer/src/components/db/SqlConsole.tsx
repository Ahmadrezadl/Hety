import { useEffect, useRef, useState, type ReactNode } from 'react'
import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { Compartment } from '@codemirror/state'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { Play, Save } from 'lucide-react'
import type { DbSchema, QueryResult, SchemaColumn } from '@shared/types'
import ResultsGrid from './ResultsGrid'

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

  const run = async (): Promise<void> => {
    const view = viewRef.current
    if (!view || !connRef.current) return
    const sel = view.state.selection.main
    const text = sel.empty
      ? view.state.doc.toString()
      : view.state.sliceDoc(sel.from, sel.to)
    const stmt = text.trim()
    if (!stmt) return
    setRunning(true)
    setError(null)
    const r = await window.api.db.query(connRef.current, stmt)
    setRunning(false)
    if (r.ok && r.data) {
      setResult(r.data)
      setError(null)
    } else {
      setError(r.ok ? 'No data' : r.error)
    }
  }
  runRef.current = run

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

  const save = (): void => {
    const view = viewRef.current
    if (!view) return
    const stmt = view.state.doc.toString().trim()
    if (!stmt) return
    const name = window.prompt('Save query as:')
    if (name && name.trim()) onSave(name.trim(), stmt)
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
          onClick={save}
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
        />
      </div>
    </div>
  )
}
