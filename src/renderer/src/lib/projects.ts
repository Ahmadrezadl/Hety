import type { Project } from '@shared/types'

export const UNGROUPED = 'Ungrouped'

export function filterProjects(projects: Project[], query: string, tag: string | null): Project[] {
  const q = query.trim().toLowerCase()
  return projects.filter((p) => {
    if (tag && !p.tags.includes(tag)) return false
    if (!q) return true
    return (
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.group.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    )
  })
}

export function groupProjects(projects: Project[]): { group: string; projects: Project[] }[] {
  const map = new Map<string, Project[]>()
  for (const p of projects) {
    const g = p.group.trim() || UNGROUPED
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(p)
  }
  const groups = [...map.entries()].map(([group, list]) => ({
    group,
    projects: list.sort((a, b) => a.name.localeCompare(b.name))
  }))
  // Named groups first (alphabetical), Ungrouped last.
  return groups.sort((a, b) => {
    if (a.group === UNGROUPED) return 1
    if (b.group === UNGROUPED) return -1
    return a.group.localeCompare(b.group)
  })
}

export function recentProjects(projects: Project[], n: number): Project[] {
  return [...projects]
    .filter((p) => p.lastOpenedAt > 0)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, n)
}

export function tagCounts(projects: Project[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const p of projects) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return counts
}

export function topTags(projects: Project[], n: number): string[] {
  return [...tagCounts(projects).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t)
}

export function allGroups(projects: Project[]): string[] {
  const set = new Set<string>()
  for (const p of projects) if (p.group.trim()) set.add(p.group.trim())
  return [...set].sort()
}
