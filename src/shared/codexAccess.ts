import type { Project } from './types'
import type { CodexAction, CodexPermissions } from './codex'

export const ACCESS_MODES = ['excluded', 'read', 'approval', 'full'] as const
export type AccessMode = typeof ACCESS_MODES[number]
export type ResourceSection = 'databases' | 'servers' | 'repositories' | 'planning'
export interface CodexAccess {
  databases: Record<string, AccessMode>
  servers: Record<string, AccessMode>
  repositories: Record<string, AccessMode>
  planning: Record<string, AccessMode>
  localFolder: AccessMode
  http: AccessMode
}
export const ACCESS_LABELS: Record<AccessMode, string> = { excluded: 'Excluded', read: 'Read only', approval: 'Approve changes', full: 'Full access' }
export const ACCESS_DESCRIPTIONS: Record<AccessMode, string> = {
  excluded: 'Hidden from context. Tools cannot access it.',
  read: 'Include in context and allow inspection. Changes are blocked.',
  approval: 'Allow reads. Review and approve every change before it runs.',
  full: 'Allow reads and writes without confirmation. Changes can be destructive.'
}
export function isAccessMode(value: unknown): value is AccessMode { return ACCESS_MODES.includes(value as AccessMode) }
export function resourceIds(project: Project, section: ResourceSection): string[] {
  return (section === 'planning' ? project.board?.columns ?? [] : project[section]).map(({ id }) => id)
}
/** Complete renderer preferences; new resources always start read-only. */
export function defaultCodexAccess(project: Project, saved?: unknown): CodexAccess {
  const input = saved && typeof saved === 'object' ? saved as Partial<CodexAccess> : {}
  const records = Object.fromEntries((['databases','servers','repositories','planning'] as const).map((section) => [section, Object.fromEntries(resourceIds(project, section).map((id) => [id, isAccessMode(input[section]?.[id]) ? input[section]![id] : 'read']))]))
  return { ...records, localFolder: isAccessMode(input.localFolder) ? input.localFolder : 'read', http: isAccessMode(input.http) ? input.http : 'approval' } as CodexAccess
}
/** Validate IPC input. Missing IDs in an explicit policy are excluded, including resources added mid-run. */
export function resolveCodexAccess(project: Project, input: unknown, legacy?: CodexPermissions): CodexAccess {
  if (input === undefined) {
    const access = defaultCodexAccess(project)
    for (const id of Object.keys(access.databases)) access.databases[id] = legacy?.databaseWrites === false ? 'read' : 'approval'
    for (const id of Object.keys(access.servers)) access.servers[id] = legacy?.serverWrites === false ? 'read' : 'approval'
    for (const id of Object.keys(access.repositories)) access.repositories[id] = legacy?.localWrites ? 'approval' : 'read'
    access.localFolder = legacy?.localWrites ? 'approval' : 'read'
    access.http = legacy?.apiWrites === false ? 'read' : 'approval'
    return access
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid context access settings.')
  const value = input as CodexAccess
  if (!isAccessMode(value.localFolder) || !isAccessMode(value.http)) throw new Error('Invalid context access mode.')
  const access = { localFolder: value.localFolder, http: value.http } as CodexAccess
  for (const section of ['databases','servers','repositories','planning'] as const) {
    const record = value[section]
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.values(record).some((mode) => !isAccessMode(mode))) throw new Error(`Invalid ${section} access settings.`)
    access[section] = Object.fromEntries(resourceIds(project, section).map((id) => [id, Object.prototype.hasOwnProperty.call(record, id) ? record[id] : 'excluded']))
  }
  return access
}
export function readableMode(mode: AccessMode | undefined): AccessMode {
  if (!isAccessMode(mode) || mode === 'excluded') throw new Error('This resource is excluded from Codex context. Include it and send a new prompt.')
  return mode
}
export function writableMode(mode: AccessMode | undefined): AccessMode {
  readableMode(mode)
  if (mode === 'read') throw new Error('This resource is read-only. Choose Approve changes or Full access and send a new prompt.')
  return mode!
}
export function actionAccessMode(access: CodexAccess, kind: CodexAction['kind'], input: Record<string, unknown>, repositoryId?: string): AccessMode {
  if (kind === 'database_write') return writableMode(access.databases[String(input.databaseId)])
  if (kind === 'ssh_execute' || kind === 'ssh_upload') return writableMode(access.servers[String(input.serverId)])
  if (kind === 'http_request' || kind === 'http_upload') return kind === 'http_request' && ['GET','HEAD'].includes(String(input.method).toUpperCase()) ? readableMode(access.http) : writableMode(access.http)
  return writableMode(repositoryId ? access.repositories[repositoryId] : access.localFolder)
}
export function scopedCodexProject(project: Project, access: CodexAccess): Project {
  const includes = (section: ResourceSection, id: string): boolean => Object.prototype.hasOwnProperty.call(access[section], id) && access[section][id] !== 'excluded'
  return { ...project, repoPath: undefined,
    databases: project.databases.filter(({ id }) => includes('databases', id)),
    servers: project.servers.filter(({ id }) => includes('servers', id)),
    repositories: project.repositories.filter(({ id }) => includes('repositories', id)),
    board: project.board ? { columns: project.board.columns.filter(({ id }) => includes('planning', id)) } : undefined
  }
}
