import { create } from 'zustand'
import type { AppData, Project, Server, Database, SavedQuery } from '@shared/types'
import { emptyAppData } from '@shared/types'

export function newId(): string {
  return crypto.randomUUID()
}

interface AppState {
  ready: boolean
  data: AppData
  selectedProjectId: string | null
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

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  data: emptyAppData(),
  selectedProjectId: null,

  load: (data) => set({ data, ready: true }),

  selectProject: (id) => {
    if (id) {
      const data = {
        ...get().data,
        projects: mapProjects(get().data, id, (p) => ({ ...p, lastOpenedAt: Date.now() }))
      }
      set({ data, selectedProjectId: id })
      persist(data)
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
      savedQueries: cur.savedQueries.filter((q) => q.projectId !== id)
    }
    set({ data, selectedProjectId: get().selectedProjectId === id ? null : get().selectedProjectId })
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
      savedQueries: get().data.savedQueries.filter((q) => q.databaseId !== id)
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
  }
}))
