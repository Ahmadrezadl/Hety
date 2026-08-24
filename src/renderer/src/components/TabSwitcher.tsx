import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal, ServerCog, GitBranch, Database as DbIcon, Columns3 } from 'lucide-react'
import {
  useApp,
  parsePlace,
  placeKey,
  projectHasLive,
  DEFAULT_TAB,
  type WorkspaceTab
} from '../store'
import { cn, ProjectIcon, StatusDot } from '../lib/ui'

const TAB_META: Record<WorkspaceTab, { label: string; icon: ReactNode }> = {
  ssh: { label: 'SSH', icon: <Terminal size={13} /> },
  ops: { label: 'Remote', icon: <ServerCog size={13} /> },
  db: { label: 'Database', icon: <DbIcon size={13} /> },
  repo: { label: 'Repository', icon: <GitBranch size={13} /> },
  board: { label: 'Planning', icon: <Columns3 size={13} /> }
}

interface Place {
  key: string
  projectId: string
  tab: WorkspaceTab
  projectName: string
  icon?: string
  live: boolean
}

interface Cycle {
  places: Place[]
  index: number
}

/**
 * Where the highlight moves on a Tab press.
 *
 * `current` is null on the first press of a cycle. Standing on a place (the
 * list's head) means a forward press skips it to reach the previous place —
 * that's what makes a quick Ctrl+Tab a "go back" gesture. From the gallery
 * nothing is current, so a forward press starts one before the head instead.
 */
export function nextIndex(
  length: number,
  step: 1 | -1,
  current: number | null,
  hasCurrent: boolean
): number {
  const from = current ?? (hasCurrent || step < 0 ? 0 : -1)
  return (from + step + length) % length
}

/**
 * Snapshot the switch list, newest first, dropping places whose project is gone.
 * `hasCurrent` is false on the project gallery, where we aren't standing on any
 * of the places — the first Tab should then land on the newest one, not skip it.
 */
function buildPlaces(): { places: Place[]; hasCurrent: boolean } {
  const { data, mru, selectedProjectId, activeTab, liveSsh, liveDb, liveOps } = useApp.getState()
  const byId = new Map(data.projects.map((p) => [p.id, p]))

  const keys = [...mru]
  const hasCurrent = !!selectedProjectId && byId.has(selectedProjectId)

  // The place we're on belongs at the head even if it hasn't been recorded yet
  // (first render after load), so the first Tab press lands on the previous one.
  if (hasCurrent) {
    const here = placeKey(selectedProjectId!, activeTab[selectedProjectId!] ?? DEFAULT_TAB)
    if (keys[0] !== here) {
      const rest = keys.filter((k) => k !== here)
      keys.length = 0
      keys.push(here, ...rest)
    }
  }

  const places: Place[] = []
  for (const key of keys) {
    const parsed = parsePlace(key)
    if (!parsed) continue
    const project = byId.get(parsed.projectId)
    if (!project || !TAB_META[parsed.tab]) continue
    places.push({
      key,
      projectId: parsed.projectId,
      tab: parsed.tab,
      projectName: project.name,
      icon: project.icon,
      live: projectHasLive(liveSsh, liveDb, liveOps, project.id)
    })
  }
  return { places, hasCurrent }
}

/**
 * Ctrl+Tab switching over recently visited project tabs, the way editors and
 * browsers do it: hold Ctrl to keep the list up and step through it, release to
 * commit. A quick press-and-release therefore lands on the previous place.
 */
export default function TabSwitcher(): ReactNode {
  const [cycle, setCycle] = useState<Cycle | null>(null)
  const cycleRef = useRef<Cycle | null>(null)

  const update = (next: Cycle | null): void => {
    cycleRef.current = next
    setCycle(next)
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey) return
      // The palette owns Tab while it's open.
      if (useApp.getState().paletteOpen) return

      const active = cycleRef.current
      const snapshot = active ? { places: active.places, hasCurrent: true } : buildPlaces()
      const { places, hasCurrent } = snapshot
      // Standing on the only place there is means there's nowhere to go.
      if (hasCurrent ? places.length < 2 : places.length === 0) return

      // Capture phase, so the key never reaches a terminal or the SQL editor.
      e.preventDefault()
      e.stopPropagation()

      const step = e.shiftKey ? -1 : 1
      update({
        places,
        index: nextIndex(places.length, step, active?.index ?? null, hasCurrent)
      })
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== 'Control') return
      const active = cycleRef.current
      if (!active) return
      update(null)

      const target = active.places[active.index]
      if (!target) return
      const { setActiveTab, selectProject } = useApp.getState()
      setActiveTab(target.projectId, target.tab)
      selectProject(target.projectId)
    }

    const cancel = (): void => update(null)

    const onEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && cycleRef.current) {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keydown', onEscape, true)
    window.addEventListener('keyup', onKeyUp, true)
    // Leaving the app mid-cycle abandons the switch rather than committing a
    // selection the user can no longer see.
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keydown', onEscape, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', cancel)
    }
  }, [])

  if (!cycle) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[300] flex items-center justify-center">
      <div className="w-[380px] overflow-hidden rounded-xl border border-line bg-bg-panel/95 shadow-2xl backdrop-blur">
        <div className="border-b border-line px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
          Recent
        </div>
        <div className="max-h-[320px] overflow-hidden py-1">
          {cycle.places.map((place, i) => {
            const meta = TAB_META[place.tab]
            return (
              <div
                key={place.key}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2',
                  i === cycle.index ? 'bg-accent-dim' : ''
                )}
              >
                <span
                  className={cn(
                    'flex w-[18px] shrink-0 justify-center',
                    i === cycle.index ? 'text-accent' : 'text-ink-faint'
                  )}
                >
                  <ProjectIcon icon={place.icon} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'truncate text-[13px] font-semibold',
                        i === cycle.index ? 'text-ink' : 'text-ink-soft'
                      )}
                    >
                      {place.projectName}
                    </span>
                    {place.live && <StatusDot color="#46c08a" />}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-faint">
                  {meta.icon}
                  {meta.label}
                </span>
              </div>
            )
          })}
        </div>
        <div className="border-t border-line px-4 py-1.5 text-[10px] text-ink-faint">
          Hold Ctrl and press Tab · release to switch
        </div>
      </div>
    </div>
  )
}
