import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus, X, Trash2, MoreHorizontal, Columns3, Pencil } from 'lucide-react'
import type { Project, Board, BoardColumn, BoardCard } from '@shared/types'
import { useApp, newId } from '../../store'
import { Button, Input, Field, Modal, ColorPicker, cn } from '../../lib/ui'

function defaultBoard(): Board {
  return {
    columns: [
      { id: newId(), name: 'To Do', cards: [] },
      { id: newId(), name: 'In Progress', cards: [] },
      { id: newId(), name: 'Done', cards: [] }
    ]
  }
}

export default function BoardPanel({ project }: { project: Project }): ReactNode {
  const upsertProject = useApp((s) => s.upsertProject)
  // Use a stable in-memory default until the user first edits the board.
  const board = useMemo(() => project.board ?? defaultBoard(), [project.board, project.id])

  const [addingCol, setAddingCol] = useState<string | null>(null)
  const [newCard, setNewCard] = useState('')
  const [renamingCol, setRenamingCol] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menuCol, setMenuCol] = useState<string | null>(null)
  const [editCard, setEditCard] = useState<{ colId: string; card: BoardCard } | null>(null)

  const dragCard = useRef<{ cardId: string; fromCol: string } | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [overCard, setOverCard] = useState<string | null>(null)

  const setBoard = (b: Board): void => upsertProject({ ...project, board: b })
  const mapCols = (fn: (c: BoardColumn) => BoardColumn): void =>
    setBoard({ ...board, columns: board.columns.map(fn) })

  // ---- column ops ----
  const addColumn = (): void => {
    const col: BoardColumn = { id: newId(), name: 'New Column', cards: [] }
    setBoard({ ...board, columns: [...board.columns, col] })
    setRenamingCol(col.id)
    setRenameValue(col.name)
  }
  const renameColumn = (id: string, name: string): void => {
    const n = name.trim()
    if (n) mapCols((c) => (c.id === id ? { ...c, name: n } : c))
    setRenamingCol(null)
  }
  const patchColumn = (id: string, patch: Partial<BoardColumn>): void =>
    mapCols((c) => (c.id === id ? { ...c, ...patch } : c))
  const deleteColumn = (id: string): void => {
    const col = board.columns.find((c) => c.id === id)
    if (col && col.cards.length && !confirm(`Delete column “${col.name}” and its ${col.cards.length} card(s)?`))
      return
    setBoard({ ...board, columns: board.columns.filter((c) => c.id !== id) })
  }

  // ---- card ops ----
  const addCard = (colId: string, title: string): void => {
    const t = title.trim()
    if (!t) return
    const card: BoardCard = { id: newId(), title: t, createdAt: Date.now() }
    mapCols((c) => (c.id === colId ? { ...c, cards: [...c.cards, card] } : c))
  }
  const updateCard = (colId: string, cardId: string, patch: Partial<BoardCard>): void =>
    mapCols((c) =>
      c.id === colId
        ? { ...c, cards: c.cards.map((cd) => (cd.id === cardId ? { ...cd, ...patch } : cd)) }
        : c
    )
  const deleteCard = (colId: string, cardId: string): void =>
    mapCols((c) => (c.id === colId ? { ...c, cards: c.cards.filter((cd) => cd.id !== cardId) } : c))

  const moveCard = (cardId: string, fromCol: string, toCol: string, beforeCardId?: string): void => {
    const columns = board.columns.map((c) => ({ ...c, cards: [...c.cards] }))
    const from = columns.find((c) => c.id === fromCol)
    const to = columns.find((c) => c.id === toCol)
    if (!from || !to) return
    const idx = from.cards.findIndex((c) => c.id === cardId)
    if (idx < 0) return
    const [card] = from.cards.splice(idx, 1)
    if (!to.deleteOnDrop) {
      let at = to.cards.length
      if (beforeCardId) {
        const bi = to.cards.findIndex((c) => c.id === beforeCardId)
        if (bi >= 0) at = bi
      }
      to.cards.splice(at, 0, card)
    }
    setBoard({ ...board, columns })
  }

  const dropOnColumn = (colId: string): void => {
    const d = dragCard.current
    const before = overCard
    dragCard.current = null
    setOverCol(null)
    setOverCard(null)
    if (d) moveCard(d.cardId, d.fromCol, colId, before ?? undefined)
  }

  return (
    <div className="flex h-full flex-col bg-bg-base">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Columns3 size={15} className="text-accent" />
        <span className="text-[13px] font-bold">Planning</span>
        <span className="text-[11px] text-ink-faint">
          {board.columns.length} column{board.columns.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto p-4">
        {board.columns.map((col) => (
          <div
            key={col.id}
            onDragOver={(e) => {
              e.preventDefault()
              setOverCol(col.id)
              setOverCard(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              dropOnColumn(col.id)
            }}
            className={cn(
              'flex max-h-full w-72 shrink-0 flex-col rounded-xl border bg-bg-panel',
              overCol === col.id
                ? col.deleteOnDrop
                  ? 'border-bad ring-2 ring-bad/40'
                  : 'border-accent ring-2 ring-accent/30'
                : 'border-line'
            )}
            style={col.color ? { borderTopColor: col.color, borderTopWidth: 2 } : undefined}
          >
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2">
              {col.deleteOnDrop && <Trash2 size={13} className="shrink-0 text-bad" />}
              {renamingCol === col.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => renameColumn(col.id, renameValue)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') renameColumn(col.id, renameValue)
                    else if (e.key === 'Escape') setRenamingCol(null)
                  }}
                  className="min-w-0 flex-1 rounded bg-bg-input px-1 py-0.5 text-[13px] font-bold outline-none ring-1 ring-accent"
                />
              ) : (
                <span
                  onDoubleClick={() => {
                    setRenamingCol(col.id)
                    setRenameValue(col.name)
                  }}
                  className="min-w-0 flex-1 truncate text-[13px] font-bold"
                  title="Double-click to rename"
                >
                  {col.name}
                </span>
              )}
              <span className="shrink-0 text-[11px] text-ink-faint">{col.cards.length}</span>
              <div className="relative shrink-0">
                <button
                  onClick={() => setMenuCol((m) => (m === col.id ? null : col.id))}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint hover:bg-bg-hover hover:text-ink"
                  title="Column settings"
                >
                  <MoreHorizontal size={15} />
                </button>
                {menuCol === col.id && (
                  <ColumnMenu
                    col={col}
                    onClose={() => setMenuCol(null)}
                    onRename={() => {
                      setRenamingCol(col.id)
                      setRenameValue(col.name)
                    }}
                    onToggleDelete={(v) => patchColumn(col.id, { deleteOnDrop: v })}
                    onColor={(c) => patchColumn(col.id, { color: c })}
                    onDelete={() => deleteColumn(col.id)}
                  />
                )}
              </div>
            </div>

            {/* Cards */}
            <div className="min-h-[8px] flex-1 space-y-2 overflow-y-auto px-2 pb-1">
              {col.cards.map((card) => (
                <div
                  key={card.id}
                  draggable
                  onDragStart={(e) => {
                    dragCard.current = { cardId: card.id, fromCol: col.id }
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => {
                    setOverCol(null)
                    setOverCard(null)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setOverCol(col.id)
                    setOverCard(card.id)
                  }}
                  onClick={() => setEditCard({ colId: col.id, card })}
                  className={cn(
                    'cursor-pointer rounded-lg border bg-bg-elevated px-3 py-2 hover:border-accent',
                    overCard === card.id ? 'border-t-2 border-t-accent border-line' : 'border-line'
                  )}
                >
                  <div className="whitespace-pre-wrap break-words text-[13px]">{card.title}</div>
                  {card.description && (
                    <div className="mt-1 line-clamp-2 text-[11px] text-ink-faint">{card.description}</div>
                  )}
                </div>
              ))}
              {col.deleteOnDrop && col.cards.length === 0 && (
                <div className="rounded-lg border border-dashed border-bad/40 p-3 text-center text-[11px] text-bad/80">
                  Drop cards here to delete them
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="p-2">
              {addingCol === col.id ? (
                <div>
                  <textarea
                    autoFocus
                    value={newCard}
                    onChange={(e) => setNewCard(e.target.value)}
                    placeholder="Card title…"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        if (newCard.trim()) {
                          addCard(col.id, newCard)
                          setNewCard('')
                        }
                      } else if (e.key === 'Escape') {
                        setAddingCol(null)
                        setNewCard('')
                      }
                    }}
                    className="field-input min-h-[52px] w-full resize-none text-[13px]"
                  />
                  <div className="mt-1.5 flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={!newCard.trim()}
                      onClick={() => {
                        addCard(col.id, newCard)
                        setNewCard('')
                      }}
                    >
                      Add card
                    </Button>
                    <button
                      className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-ink"
                      onClick={() => {
                        setAddingCol(null)
                        setNewCard('')
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setAddingCol(col.id)
                    setNewCard('')
                  }}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
                >
                  <Plus size={14} /> Add a card
                </button>
              )}
            </div>
          </div>
        ))}

        <button
          onClick={addColumn}
          className="flex h-10 w-72 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed border-line text-[12px] font-semibold text-ink-soft hover:border-accent hover:bg-bg-hover hover:text-ink"
        >
          <Plus size={15} /> Add column
        </button>
      </div>

      {editCard && (
        <CardModal
          card={editCard.card}
          onClose={() => setEditCard(null)}
          onSave={(title, description) => {
            updateCard(editCard.colId, editCard.card.id, { title, description: description || undefined })
            setEditCard(null)
          }}
          onDelete={() => {
            deleteCard(editCard.colId, editCard.card.id)
            setEditCard(null)
          }}
        />
      )}
    </div>
  )
}

function ColumnMenu({
  col,
  onClose,
  onRename,
  onToggleDelete,
  onColor,
  onDelete
}: {
  col: BoardColumn
  onClose: () => void
  onRename: () => void
  onToggleDelete: (v: boolean) => void
  onColor: (c?: string) => void
  onDelete: () => void
}): ReactNode {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-0 top-full z-40 mt-1 w-60 rounded-lg border border-line bg-bg-panel p-1.5 text-[12px] shadow-xl">
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg-hover"
          onClick={() => {
            onRename()
            onClose()
          }}
        >
          <Pencil size={13} /> Rename column
        </button>
        <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover">
          <input
            type="checkbox"
            checked={!!col.deleteOnDrop}
            onChange={(e) => onToggleDelete(e.target.checked)}
          />
          <span className="flex items-center gap-1">
            <Trash2 size={12} className="text-bad" /> Delete cards dropped here
          </span>
        </label>
        <div className="px-2 py-1.5">
          <div className="mb-1.5 text-[11px] font-semibold text-ink-faint">Color</div>
          <ColorPicker value={col.color} onChange={onColor} />
        </div>
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-bad hover:bg-bg-hover"
          onClick={() => {
            onDelete()
            onClose()
          }}
        >
          <Trash2 size={13} /> Delete column
        </button>
      </div>
    </>
  )
}

function CardModal({
  card,
  onClose,
  onSave,
  onDelete
}: {
  card: BoardCard
  onClose: () => void
  onSave: (title: string, description: string) => void
  onDelete: () => void
}): ReactNode {
  const [title, setTitle] = useState(card.title)
  const [desc, setDesc] = useState(card.description ?? '')
  return (
    <Modal title="Edit card" width={520} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Title">
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea
            className="field-input min-h-[120px] resize-none"
            placeholder="Add more detail…"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </Field>
        <div className="flex items-center justify-between gap-2">
          <Button variant="danger" onClick={onDelete}>
            <Trash2 size={14} /> Delete
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!title.trim()} onClick={() => onSave(title.trim(), desc.trim())}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
