import { ipcMain } from 'electron'
import simpleGit, { type SimpleGit } from 'simple-git'
import type { GitStatus, GitFile, GitCommit, Result } from '@shared/types'

function git(path: string): SimpleGit {
  return simpleGit(path)
}

async function status(path: string): Promise<GitStatus> {
  const g = git(path)
  let isRepo = false
  try {
    isRepo = await g.checkIsRepo()
  } catch {
    isRepo = false
  }
  if (!isRepo) {
    return {
      isRepo: false,
      branch: '',
      branches: [],
      remoteBranches: [],
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: []
    }
  }
  const s = await g.status()
  let branches: string[] = []
  try {
    branches = (await g.branchLocal()).all
  } catch {
    branches = []
  }
  let remoteBranches: string[] = []
  try {
    remoteBranches = (await g.branch(['-r'])).all.filter((b) => !b.includes('->'))
  } catch {
    remoteBranches = []
  }
  const staged: GitFile[] = []
  const unstaged: GitFile[] = []
  for (const f of s.files) {
    const index = f.index?.trim()
    const working = f.working_dir?.trim()
    if (index && index !== '?') staged.push({ path: f.path, code: index })
    if (working) unstaged.push({ path: f.path, code: working === '?' ? '?' : working })
  }
  return {
    isRepo: true,
    branch: s.current ?? '',
    branches,
    remoteBranches,
    ahead: s.ahead,
    behind: s.behind,
    staged,
    unstaged
  }
}

async function log(path: string): Promise<GitCommit[]> {
  const g = git(path)
  try {
    const res = await g.log({ maxCount: 30 })
    const now = Date.now()
    return res.all.map((c) => ({
      hash: c.hash.slice(0, 7),
      message: c.message,
      author: c.author_name,
      date: c.date,
      relative: humanize(now - new Date(c.date).getTime())
    }))
  } catch {
    return []
  }
}

function humanize(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const units: [string, number][] = [
    ['y', 31536000],
    ['mo', 2592000],
    ['d', 86400],
    ['h', 3600],
    ['m', 60]
  ]
  for (const [u, size] of units) if (s >= size) return `${Math.floor(s / size)}${u} ago`
  return 'just now'
}

function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn()
    .then((data) => ({ ok: true as const, data }))
    .catch((e: Error) => ({ ok: false as const, error: e.message }))
}

export function registerGitIpc(): void {
  ipcMain.handle('git:status', (_e, path: string) => wrap(() => status(path)))
  ipcMain.handle('git:log', (_e, path: string) => wrap(() => log(path)))

  ipcMain.handle('git:stage', (_e, { path, files }: { path: string; files: string[] }) =>
    wrap(async () => {
      await git(path).add(files)
    })
  )
  ipcMain.handle('git:stageAll', (_e, path: string) =>
    wrap(async () => {
      await git(path).add(['-A'])
    })
  )
  ipcMain.handle('git:unstage', (_e, { path, files }: { path: string; files: string[] }) =>
    wrap(async () => {
      await git(path).reset(['--', ...files])
    })
  )
  ipcMain.handle('git:unstageAll', (_e, path: string) =>
    wrap(async () => {
      await git(path).reset([])
    })
  )
  ipcMain.handle('git:discard', (_e, { path, files }: { path: string; files: string[] }) =>
    wrap(async () => {
      const g = git(path)
      for (const f of files) {
        try {
          await g.checkout(['--', f])
        } catch {
          await g.clean('f', [f])
        }
      }
    })
  )
  ipcMain.handle('git:commit', (_e, { path, message }: { path: string; message: string }) =>
    wrap(async () => {
      await git(path).commit(message)
    })
  )
  ipcMain.handle('git:checkout', (_e, { path, branch }: { path: string; branch: string }) =>
    wrap(async () => {
      await git(path).checkout(branch)
    })
  )
  ipcMain.handle('git:checkoutRemote', (_e, { path, ref }: { path: string; ref: string }) =>
    wrap(async () => {
      // ref like "origin/feature" -> create/switch to a local tracking branch
      const short = ref.replace(/^[^/]+\//, '')
      const g = git(path)
      try {
        await g.checkout(short)
      } catch {
        await g.checkout(['--track', ref])
      }
    })
  )
  ipcMain.handle('git:fetch', (_e, path: string) =>
    wrap(async () => {
      await git(path).fetch(['--all'])
    })
  )
  ipcMain.handle('git:pull', (_e, path: string) =>
    wrap(async () => {
      await git(path).pull()
    })
  )
  ipcMain.handle('git:push', (_e, path: string) =>
    wrap(async () => {
      await git(path).push()
    })
  )
}
