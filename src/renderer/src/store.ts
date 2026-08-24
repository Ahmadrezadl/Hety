import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type {
  AppData,
  Project,
  Server,
  Database,
  SavedQuery,
  QueryHistoryEntry
} from '@shared/types'
import { emptyAppData, QUERY_HISTORY_LIMIT } from '@shared/types'
import { normalizeAppData } from './lib/projects'

export function newId(): string {
  return crypto.randomUUID()
}

type LiveKind = 'ssh' | 'db' | 'ops'

/** The tabs inside a project's Workspace. */
export type WorkspaceTab = 'ssh' | 'ops' | 'db' | 'repo' | 'board'

export const DEFAULT_TAB: WorkspaceTab = 'ssh'

/** How many recently visited places Ctrl+Tab remembers. */
const MRU_LIMIT = 40

/** A "place" is one project's tab — the unit Ctrl+Tab cycles through. */
export function placeKey(projectId: string, tab: WorkspaceTab): string {
  return `${projectId}::${tab}`
}

export function parsePlace(key: string): { projectId: string; tab: WorkspaceTab } | null {
  const at = key.indexOf('::')
  if (at < 0) return null
  return { projectId: key.slice(0, at), tab: key.slice(at + 2) as WorkspaceTab }
}

export type OpenTargetKind = 'server' | 'database' | 'repository' | 'query'

/** A one-shot "go here and focus this" request, raised by the command palette
 *  and picked up by whichever panel owns the target. */
export interface OpenRequest {
  projectId: string
  tab: WorkspaceTab
  targetKind?: OpenTargetKind
  targetId?: string
  /** Bumped on every request so asking for the same target twice re-fires. */
  nonce: number
}

interface AppState {
  ready: boolean
  data: AppData
  selectedProjectId: string | null
  /** Projects whose Workspace stays mounted so SSH/DB sessions survive switching. */
  openProjectIds: string[]
  /** Live connection keys keyed by project id (ssh sessions / db connections / remote ops). */
  liveSsh: Record<string, string[]>
  liveDb: Record<string, string[]>
  liveOps: Record<string, string[]>
  /** Active Workspace tab per project — lifted out of Workspace so the palette can set it. */
  activeTab: Record<string, WorkspaceTab>
  openRequest: OpenRequest | null
  paletteOpen: boolean
  /** Recently visited places, most recent first — the Ctrl+Tab order. */
  mru: string[]
  touchPlace: (projectId: string, tab: WorkspaceTab) => void
  setActiveTab: (projectId: string, tab: WorkspaceTab) => void
  requestOpen: (req: Omit<OpenRequest, 'nonce'>) => void
  setPaletteOpen: (open: boolean) => void
  load: (data: AppData) => void
  selectProject: (id: string | null) => void
  upsertProject: (p: Project) => void
  deleteProject: (id: string) => void
  upsertServer: (projectId: string, s: Server) => void
  deleteServer: (projectId: string, id: string) => void
  upsertDatabase: (projectId: string, d: Database) => void
  deleteDatabase: (projectId: string, id: string) => void
  addSavedQuery: (q: SavedQuery) => void
  deleteSavedQuery: (id: string) => void
  addQueryHistory: (entry: QueryHistoryEntry) => void
  deleteQueryHistory: (id: string) => void
  /** Clear the whole log, or just one database's entries. */
  clearQueryHistory: (databaseId?: string) => void
  setLive: (kind: LiveKind, projectId: string, key: string, live: boolean) => void
}

function persist(data: AppData): void {
  void window.api.store.save(data)
}

function mapProjects(
  data: AppData,
  projectId: string,
  fn: (p: Project) => Project
): Project[] {
  return data.projects.map((p) => (p.id === projectId ? fn(p) : p))
}

function patchLive(
  map: Record<string, string[]>,
  projectId: string,
  key: string,
  live: boolean
): Record<string, string[]> {
  const cur = map[projectId] ?? []
  const has = cur.includes(key)
  if (live && has) return map
  if (!live && !has) return map
  const next = live ? [...cur, key] : cur.filter((k) => k !== key)
  if (next.length === 0) {
    const { [projectId]: _, ...rest } = map
    return rest
  }
  return { ...map, [projectId]: next }
}

export function projectHasLive(
  liveSsh: Record<string, string[]>,
  liveDb: Record<string, string[]>,
  liveOps: Record<string, string[]>,
  projectId: string
): boolean {
  return (
    (liveSsh[projectId]?.length ?? 0) > 0 ||
    (liveDb[projectId]?.length ?? 0) > 0 ||
    (liveOps[projectId]?.length ?? 0) > 0
  )
}

/** Stable empty list for zustand selectors — never return a fresh `[]` from getSnapshot. */
export const EMPTY_LIVE: string[] = []

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  data: emptyAppData(),
  selectedProjectId: null,
  openProjectIds: [],
  liveSsh: {},
  liveDb: {},
  liveOps: {},
  activeTab: {},
  openRequest: null,
  paletteOpen: false,
  mru: [],

  touchPlace: (projectId, tab) => {
    const key = placeKey(projectId, tab)
    const current = get().mru
    if (current[0] === key) return
    set({ mru: [key, ...current.filter((k) => k !== key)].slice(0, MRU_LIMIT) })
  },

  setActiveTab: (projectId, tab) =>
    set({ activeTab: { ...get().activeTab, [projectId]: tab } }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),

  requestOpen: (req) => {
    get().selectProject(req.projectId)
    set({
      activeTab: { ...get().activeTab, [req.projectId]: req.tab },
      openRequest: { ...req, nonce: (get().openRequest?.nonce ?? 0) + 1 },
      paletteOpen: false
    })
  },

  load: (data) => set({ data: normalizeAppData(data), ready: true }),

  selectProject: (id) => {
    if (id) {
      const open = get().openProjectIds
      // Only bump lastOpenedAt when first opening a project this session —
      // switching back to an already-open project must not reshuffle Recents.
      if (!open.includes(id)) {
        const data = {
          ...get().data,
          projects: mapProjects(get().data, id, (p) => ({ ...p, lastOpenedAt: Date.now() }))
        }
        set({ data, selectedProjectId: id, openProjectIds: [...open, id] })
        persist(data)
      } else {
        set({ selectedProjectId: id })
      }
    } else {
      set({ selectedProjectId: null })
    }
  },

  upsertProject: (p) => {
    const cur = get().data
    const exists = cur.projects.some((x) => x.id === p.id)
    const projects = exists
      ? cur.projects.map((x) => (x.id === p.id ? p : x))
      : [...cur.projects, p]
    const data = { ...cur, projects }
    set({ data })
    persist(data)
  },

  deleteProject: (id) => {
    const cur = get().data
    const data = {
      ...cur,
      projects: cur.projects.filter((p) => p.id !== id),
      savedQueries: cur.savedQueries.filter((q) => q.projectId !== id),
      queryHistory: (cur.queryHistory ?? []).filter((h) => h.projectId !== id)
    }
    const { [id]: _s, ...liveSsh } = get().liveSsh
    const { [id]: _d, ...liveDb } = get().liveDb
    const { [id]: _o, ...liveOps } = get().liveOps
    const { [id]: _t, ...activeTab } = get().activeTab
    set({
      data,
      selectedProjectId: get().selectedProjectId === id ? null : get().selectedProjectId,
      openProjectIds: get().openProjectIds.filter((x) => x !== id),
      liveSsh,
      liveDb,
      liveOps,
      activeTab,
      mru: get().mru.filter((k) => parsePlace(k)?.projectId !== id)
    })
    persist(data)
  },

  upsertServer: (projectId, s) => {
    const data = {
      ...get().data,
      projects: mapProjects(get().data, projectId, (p) => {
        const exists = p.servers.some((x) => x.id === s.id)
        return {
          ...p,
          servers: exists ? p.servers.map((x) => (x.id === s.id ? s : x)) : [...p.servers, s]
        }
      })
    }
    set({ data })
    persist(data)
  },

  deleteServer: (projectId, id) => {
    const data = {
      ...get().data,
      projects: mapProjects(get().data, projectId, (p) => ({
        ...p,
        servers: p.servers.filter((x) => x.id !== id)
      }))
    }
    set({ data })
    persist(data)
  },

  upsertDatabase: (projectId, d) => {
    const data = {
      ...get().data,
      projects: mapProjects(get().data, projectId, (p) => {
        const exists = p.databases.some((x) => x.id === d.id)
        return {
          ...p,
          databases: exists ? p.databases.map((x) => (x.id === d.id ? d : x)) : [...p.databases, d]
        }
      })
    }
    set({ data })
    persist(data)
  },

  deleteDatabase: (projectId, id) => {
    const data = {
      ...get().data,
      projects: mapProjects(get().data, projectId, (p) => ({
        ...p,
        databases: p.databases.filter((x) => x.id !== id)
      })),
      savedQueries: get().data.savedQueries.filter((q) => q.databaseId !== id),
      queryHistory: (get().data.queryHistory ?? []).filter((h) => h.databaseId !== id)
    }
    set({ data })
    persist(data)
  },

  addSavedQuery: (q) => {
    const data = { ...get().data, savedQueries: [q, ...get().data.savedQueries] }
    set({ data })
    persist(data)
  },

  deleteSavedQuery: (id) => {
    const data = {
      ...get().data,
      savedQueries: get().data.savedQueries.filter((q) => q.id !== id)
    }
    set({ data })
    persist(data)
  },

  addQueryHistory: (entry) => {
    const previous = get().data.queryHistory ?? []
    // Re-running the same statement moves the existing entry up rather than
    // filling the log with duplicates.
    const deduped = previous.filter(
      (h) => !(h.sql === entry.sql && h.databaseId === entry.databaseId)
    )
    const data = {
      ...get().data,
      queryHistory: [entry, ...deduped].slice(0, QUERY_HISTORY_LIMIT)
    }
    set({ data })
    persist(data)
  },

  deleteQueryHistory: (id) => {
    const data = {
      ...get().data,
      queryHistory: (get().data.queryHistory ?? []).filter((h) => h.id !== id)
    }
    set({ data })
    persist(data)
  },

  clearQueryHistory: (databaseId) => {
    const previous = get().data.queryHistory ?? []
    const data = {
      ...get().data,
      queryHistory: databaseId ? previous.filter((h) => h.databaseId !== databaseId) : []
    }
    set({ data })
    persist(data)
  },

  setLive: (kind, projectId, key, live) => {
    if (kind === 'ssh') {
      set({ liveSsh: patchLive(get().liveSsh, projectId, key, live) })
    } else if (kind === 'db') {
      set({ liveDb: patchLive(get().liveDb, projectId, key, live) })
    } else {
      set({ liveOps: patchLive(get().liveOps, projectId, key, live) })
    }
  }
}))

/**
 * Run `handler` when the palette asks this project/tab to focus something.
 * Each request fires once per panel — the nonce it was last seen at is tracked
 * locally, so no store write is needed to "consume" it.
 */
export function useOpenRequest(
  projectId: string,
  tab: WorkspaceTab,
  handler: (target: { kind?: OpenTargetKind; id?: string }) => void
): void {
  const request = useApp((s) => s.openRequest)
  const seen = useRef(0)
  const cb = useRef(handler)
  cb.current = handler

  useEffect(() => {
    if (!request || request.nonce === seen.current) return
    if (request.projectId !== projectId || request.tab !== tab) return
    seen.current = request.nonce
    cb.current({ kind: request.targetKind, id: request.targetId })
  }, [request, projectId, tab])
}
