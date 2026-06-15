import { useMemo, type ReactNode } from 'react'
import { cn } from '../../lib/ui'

type RowType = 'add' | 'del' | 'ctx' | 'hunk'
interface Row {
  type: RowType
  text: string
  oldNo?: number
  newNo?: number
}

const META_RE = /^(diff |index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |copy |Binary )/

function parse(diff: string): Row[] {
  const rows: Row[] = []
  let o = 0
  let n = 0
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        o = parseInt(m[1], 10)
        n = parseInt(m[2], 10)
      }
      rows.push({ type: 'hunk', text: line })
      continue
    }
    if (META_RE.test(line) || line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      rows.push({ type: 'add', text: line.slice(1), newNo: n })
      n++
      continue
    }
    if (line.startsWith('-')) {
      rows.push({ type: 'del', text: line.slice(1), oldNo: o })
      o++
      continue
    }
    rows.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: o, newNo: n })
    o++
    n++
  }
  return rows
}

function Center({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-xs text-ink-faint">
      {children}
    </div>
  )
}

/** Render a unified diff with old/new line-number gutters and +/- coloring. */
export default function DiffView({
  diff,
  loading,
  empty
}: {
  diff?: string | null
  loading?: boolean
  empty?: string
}): ReactNode {
  const rows = useMemo(() => (diff ? parse(diff) : []), [diff])
  if (loading) return <Center>Loading diff…</Center>
  if (!diff || !diff.trim()) return <Center>{empty ?? 'Select a file to see its diff.'}</Center>
  if (rows.length === 0) return <Center>No textual changes (binary or whitespace-only).</Center>

  return (
    <div className="h-full overflow-auto bg-bg-base font-mono text-[12px] leading-[1.55]">
      {rows.map((r, i) => {
        if (r.type === 'hunk')
          return (
            <div key={i} className="bg-accent-dim/30 px-3 py-0.5 text-[11px] text-accent">
              {r.text}
            </div>
          )
        const bg = r.type === 'add' ? 'bg-ok/10' : r.type === 'del' ? 'bg-bad/10' : ''
        const fg = r.type === 'add' ? 'text-ok' : r.type === 'del' ? 'text-bad' : 'text-ink-soft'
        const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '
        return (
          <div key={i} className={cn('flex', bg)}>
            <span className="w-10 shrink-0 select-none border-r border-line/40 px-1 text-right text-[10px] text-ink-faint">
              {r.oldNo ?? ''}
            </span>
            <span className="w-10 shrink-0 select-none border-r border-line/40 px-1 text-right text-[10px] text-ink-faint">
              {r.newNo ?? ''}
            </span>
            <span className={cn('shrink-0 select-none pl-2 pr-1', fg)}>{sign}</span>
            <span className={cn('whitespace-pre-wrap break-all pr-3', fg)}>{r.text || ' '}</span>
          </div>
        )
      })}
    </div>
  )
}
