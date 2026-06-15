import { useState, type ReactNode } from 'react'
import { X, Folder } from 'lucide-react'
import type { Project } from '@shared/types'
import { useApp, newId } from '../../store'
import { allGroups } from '../../lib/projects'
import { Button, Field, Input, Modal } from '../../lib/ui'

export default function ProjectDialog({
  project,
  onClose
}: {
  project?: Project
  onClose: () => void
}): ReactNode {
  const upsertProject = useApp((s) => s.upsertProject)
  const groups = allGroups(useApp((s) => s.data.projects))

  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [group, setGroup] = useState(project?.group ?? '')
  const [tags, setTags] = useState<string[]>(project?.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [repoPath, setRepoPath] = useState(project?.repoPath ?? '')

  const addTag = (): void => {
    const t = tagInput.trim().toLowerCase()
    if (t && !tags.includes(t)) setTags([...tags, t])
    setTagInput('')
  }

  const save = (): void => {
    if (!name.trim()) return
    const base: Project = project ?? {
      id: newId(),
      name: '',
      description: '',
      group: '',
      tags: [],
      repoPath: '',
      servers: [],
      databases: [],
      createdAt: Date.now(),
      lastOpenedAt: 0
    }
    upsertProject({
      ...base,
      name: name.trim(),
      description: description.trim(),
      group: group.trim(),
      tags,
      repoPath: repoPath.trim()
    })
    onClose()
  }

  const browse = async (): Promise<void> => {
    const p = await window.api.app.pickFolder()
    if (p) setRepoPath(p)
  }

  return (
    <Modal title={project ? 'Edit project' : 'New project'} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name">
          <Input autoFocus placeholder="My project" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Description">
          <textarea
            className="field-input min-h-[64px] resize-none"
            placeholder="What is this project about?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Group" hint="Projects with the same group are bundled together.">
            <Input
              list="hety-groups"
              placeholder="e.g. Work, Personal"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            />
            <datalist id="hety-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>

          <Field label="Repository path" hint="Used by the Repository tab.">
            <div className="flex gap-2">
              <Input placeholder="C:\path\to\repo" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
              <button
                onClick={browse}
                className="btn-ghost btn shrink-0 px-2"
                title="Browse"
                type="button"
              >
                <Folder size={15} />
              </button>
            </div>
          </Field>
        </div>

        <Field label="Tags">
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-bg-input px-2 py-2">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-md bg-accent-dim px-2 py-0.5 text-[11px] font-semibold text-accent-hover"
              >
                {t}
                <button onClick={() => setTags(tags.filter((x) => x !== t))}>
                  <X size={11} />
                </button>
              </span>
            ))}
            <input
              className="min-w-[80px] flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-faint"
              placeholder="Add tag…"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addTag()
                }
              }}
              onBlur={addTag}
            />
          </div>
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} onClick={save}>
            {project ? 'Save' : 'Create project'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
