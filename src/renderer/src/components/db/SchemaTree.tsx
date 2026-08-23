import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  Table2,
  Eye,
  Tags,
  Key,
  Circle,
  Search,
  Database as DbIcon
} from 'lucide-react'
import type { DbSchema, SchemaTable, SchemaEnum, SchemaColumn } from '@shared/types'
import type { DatabaseKind } from '@shared/databases'
import { quoteIdent, quoteQualified } from '@shared/sql'

interface MenuItem {
  label: string
  onClick: () => void
}
interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

function buildTableDDL(kind: DatabaseKind | string, schemaName: string, t: SchemaTable): string {
  const lines = t.columns.map((c) => `  ${quoteIdent(kind, c.name)} ${c.type}`)
  const pks = t.columns.filter((c) => c.pk).map((c) => quoteIdent(kind, c.name))
  if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(', ')})`)
  return `CREATE TABLE ${quoteQualified(kind, schemaName, t.name)} (\n${lines.join(',\n')}\n);`
}

function buildEnumDDL(kind: DatabaseKind | string, schemaName: string, e: SchemaEnum): string {
  const vals = e.values.map((v) => `  '${v.replace(/'/g, "''")}'`).join(',\n')
  return `CREATE TYPE ${quoteQualified(kind, schemaName, e.name)} AS ENUM (\n${vals}\n);`
}

const copy = (text: string): void => void navigator.clipboard.writeText(text)

export default function SchemaTree({
  dbName,
  kind,
  schema,
  onOpenTable
}: {
  dbName: string
  kind: DatabaseKind | string
  schema?: DbSchema
  onOpenTable: (schemaName: string, table: SchemaTable) => void
}): ReactNode {
  const single = (schema?.schemas.length ?? 0) === 1
  const initial = useMemo(() => {
    const set = new Set<string>(['root'])
    if (single && schema) {
      const s = schema.schemas[0]
      set.add(`s:${s.name}`)
      set.add(`f:${s.name}:tables`)
    }
    return set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema])

  const [open, setOpen] = useState<Set<string>>(initial)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [filter, setFilter] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        if (!treeRef.current?.contains(e.target as Node)) return
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      if (!selectedKey?.startsWith('t:') && !selectedKey?.startsWith('v:')) return
      if (!treeRef.current?.contains(target) && target !== document.body) return
      if (e.key.length === 1) {
        e.preventDefault()
        setFilter((prev) => prev + e.key)
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectedKey])

  const q = filter.toLowerCase().trim()
  const forceOpen = q.length > 0
  const nameMatch = (n: string): boolean => !q || n.toLowerCase().includes(q)
  const matchingColumns = (t: SchemaTable): SchemaColumn[] =>
    q ? t.columns.filter((c) => c.name.toLowerCase().includes(q)) : []
  const tableMatch = (t: SchemaTable): boolean =>
    !q || t.name.toLowerCase().includes(q) || matchingColumns(t).length > 0

  const toggle = (k: string): void =>
    setOpen((s) => {
      const n = new Set(s)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })
  /** Containers (database / schema / folders) auto-expand while filtering… */
  const isOpen = (k: string): boolean => forceOpen || open.has(k)
  /** …but tables and enums only expand when the user asks for it, so a search
   *  doesn't dump every column of every matching table into the tree. */
  const isLeafOpen = (k: string): boolean => open.has(k)

  /** Columns to list under a table: the matches when a search hit only columns,
   *  otherwise everything (once the node is expanded by hand). */
  const tableNodeState = (
    key: string,
    t: SchemaTable
  ): { open: boolean; columns: SchemaColumn[] } => {
    const manual = isLeafOpen(key)
    if (manual) return { open: true, columns: t.columns }
    const hits = q && !t.name.toLowerCase().includes(q) ? matchingColumns(t) : []
    return { open: hits.length > 0, columns: hits }
  }

  const openMenu = (e: MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  if (!schema) {
    return <div className="px-3 py-4 text-xs text-ink-faint">Connect to browse the schema.</div>
  }

  return (
    <div
      ref={treeRef}
      tabIndex={-1}
      className="select-none text-[13px] outline-none"
      onMouseDown={() => treeRef.current?.focus()}
    >
      <div className="sticky top-0 z-10 bg-bg-panel p-2">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2 top-2 text-ink-faint" />
          <input
            ref={searchRef}
            className="w-full rounded-md bg-bg-input py-1.5 pl-7 pr-2 text-xs outline-none placeholder:text-ink-faint focus:ring-1 focus:ring-accent"
            placeholder="Search tables, columns… (Ctrl+F)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilter('')
                e.currentTarget.blur()
              }
            }}
          />
        </div>
      </div>
      <Row depth={0} open={isOpen('root')} onToggle={() => toggle('root')} icon={<DbIcon size={14} />} label={dbName} bold />
      {isOpen('root') &&
        schema.schemas.map((s) => {
          const skey = `s:${s.name}`
          const tables = s.tables.filter(tableMatch)
          const views = s.views.filter(tableMatch)
          const enums = s.enums.filter((e) => nameMatch(e.name))
          if (q && !tables.length && !views.length && !enums.length) return null
          const tableMenu = (t: SchemaTable): MenuItem[] => [
            { label: 'View data', onClick: () => onOpenTable(s.name, t) },
            { label: 'Copy schema', onClick: () => copy(buildTableDDL(kind, s.name, t)) },
            { label: 'Copy name', onClick: () => copy(t.name) }
          ]
          const body = (
            <>
              {tables.length > 0 && (
                <Folder2
                  depth={single ? 1 : 2}
                  label={`Tables (${tables.length})`}
                  open={isOpen(`f:${s.name}:tables`)}
                  onToggle={() => toggle(`f:${s.name}:tables`)}
                >
                  {tables.map((t) => {
                    const key = `t:${s.name}:${t.name}`
                    const st = tableNodeState(key, t)
                    return (
                      <TableNode
                        key={t.name}
                        table={t}
                        depth={single ? 2 : 3}
                        open={st.open}
                        columns={st.columns}
                        selected={selectedKey === key}
                        onSelect={() => setSelectedKey(key)}
                        onToggle={() => toggle(key)}
                        onOpen={() => onOpenTable(s.name, t)}
                        onContext={(e) => openMenu(e, tableMenu(t))}
                        icon={<Table2 size={13} className="text-accent" />}
                      />
                    )
                  })}
                </Folder2>
              )}
              {views.length > 0 && (
                <Folder2
                  depth={single ? 1 : 2}
                  label={`Views (${views.length})`}
                  open={isOpen(`f:${s.name}:views`)}
                  onToggle={() => toggle(`f:${s.name}:views`)}
                >
                  {views.map((t) => {
                    const key = `v:${s.name}:${t.name}`
                    const st = tableNodeState(key, t)
                    return (
                      <TableNode
                        key={t.name}
                        table={t}
                        depth={single ? 2 : 3}
                        open={st.open}
                        columns={st.columns}
                        selected={selectedKey === key}
                        onSelect={() => setSelectedKey(key)}
                        onToggle={() => toggle(key)}
                        onOpen={() => onOpenTable(s.name, t)}
                        onContext={(e) => openMenu(e, tableMenu(t))}
                        icon={<Eye size={13} className="text-ink-soft" />}
                      />
                    )
                  })}
                </Folder2>
              )}
              {enums.length > 0 && (
                <Folder2
                  depth={single ? 1 : 2}
                  label={`Enums (${enums.length})`}
                  open={isOpen(`f:${s.name}:enums`)}
                  onToggle={() => toggle(`f:${s.name}:enums`)}
                >
                  {enums.map((e) => {
                    const ek = `e:${s.name}:${e.name}`
                    return (
                      <div key={e.name}>
                        <Row
                          depth={single ? 2 : 3}
                          open={isLeafOpen(ek)}
                          onToggle={() => toggle(ek)}
                          onContext={(ev) =>
                            openMenu(ev, [
                              { label: 'Copy schema', onClick: () => copy(buildEnumDDL(kind, s.name, e)) },
                              { label: 'Copy name', onClick: () => copy(e.name) }
                            ])
                          }
                          icon={<Tags size={13} className="text-warn" />}
                          label={e.name}
                        />
                        {isLeafOpen(ek) &&
                          e.values.map((v) => (
                            <Row key={v} depth={single ? 3 : 4} leaf icon={<Circle size={6} />} label={v} muted />
                          ))}
                      </div>
                    )
                  })}
                </Folder2>
              )}
            </>
          )
          if (single) return <div key={s.name}>{body}</div>
          return (
            <div key={s.name}>
              <Row
                depth={1}
                open={isOpen(skey)}
                onToggle={() => toggle(skey)}
                icon={<Folder size={14} className="text-warn" />}
                label={s.name}
              />
              {isOpen(skey) && body}
            </div>
          )
        })}

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div
            className="fixed z-50 min-w-[160px] overflow-hidden rounded-lg border border-line bg-bg-panel py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {menu.items.map((it) => (
              <button
                key={it.label}
                className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover"
                onClick={() => {
                  it.onClick()
                  setMenu(null)
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function Folder2({
  depth,
  label,
  open,
  onToggle,
  children
}: {
  depth: number
  label: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}): ReactNode {
  return (
    <div>
      <Row depth={depth} open={open} onToggle={onToggle} label={label} folder />
      {open && children}
    </div>
  )
}

function TableNode({
  table,
  depth,
  open,
  columns,
  selected,
  onSelect,
  onToggle,
  onOpen,
  onContext,
  icon
}: {
  table: SchemaTable
  depth: number
  open: boolean
  /** columns to render when expanded (a filtered subset while searching). */
  columns: SchemaColumn[]
  selected?: boolean
  onSelect: () => void
  onToggle: () => void
  onOpen: () => void
  onContext: (e: MouseEvent) => void
  icon: ReactNode
}): ReactNode {
  return (
    <div>
      <Row
        depth={depth}
        open={open}
        onToggle={onToggle}
        onSelect={onSelect}
        onDouble={onOpen}
        onContext={onContext}
        selected={selected}
        icon={icon}
        label={table.name}
      />
      {open &&
        columns.map((c) => (
          <Row
            key={c.name}
            depth={depth + 1}
            leaf
            icon={c.pk ? <Key size={11} className="text-warn" /> : <Circle size={6} className="text-ink-faint" />}
            label={c.name}
            suffix={c.type}
          />
        ))}
    </div>
  )
}

function Row({
  depth,
  label,
  icon,
  open,
  onToggle,
  onSelect,
  onDouble,
  onContext,
  leaf,
  folder,
  bold,
  muted,
  suffix,
  selected
}: {
  depth: number
  label: string
  icon?: ReactNode
  open?: boolean
  onToggle?: () => void
  onSelect?: () => void
  onDouble?: () => void
  onContext?: (e: MouseEvent) => void
  leaf?: boolean
  folder?: boolean
  bold?: boolean
  muted?: boolean
  suffix?: string
  selected?: boolean
}): ReactNode {
  const handleClick = (): void => {
    if (onSelect) {
      onSelect()
      return
    }
    onToggle?.()
  }
  const handleChevron = (e: MouseEvent): void => {
    e.stopPropagation()
    onToggle?.()
  }
  return (
    <div
      className={`flex cursor-default items-center gap-1 rounded-md py-[3px] pr-2 hover:bg-bg-hover ${
        selected ? 'bg-accent-dim' : ''
      }`}
      style={{ paddingLeft: depth * 14 + 6 }}
      onClick={handleClick}
      onDoubleClick={onDouble}
      onContextMenu={onContext}
    >
      {!leaf ? (
        <button type="button" className="shrink-0 text-ink-faint" onClick={handleChevron}>
          {open ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {icon ? <span className="flex w-4 shrink-0 justify-center">{icon}</span> : <span className="w-4 shrink-0" />}
      <span
        className={`truncate ${bold ? 'font-bold' : folder ? 'text-[11px] font-bold uppercase tracking-wide text-ink-faint' : ''} ${
          muted ? 'text-ink-soft' : ''
        }`}
      >
        {label}
      </span>
      {suffix && <span className="ml-auto truncate pl-2 text-[11px] text-ink-faint">{suffix}</span>}
    </div>
  )
}
