import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { X, Upload } from 'lucide-react'
import type { Project } from '@shared/types'
import { useApp, newId } from '../../store'
import { allGroups } from '../../lib/projects'
import { Button, Field, Input, Modal, ProjectIcon, cn } from '../../lib/ui'

const PROJECT_EMOJIS = [
  '🚀', '🛠️', '📦', '🌐', '🔧', '⚙️', '🗄️', '💾', '🧩', '📱',
  '🖥️', '🤖', '🔮', '🧪', '📊', '🔐', '☁️', '🐳', '🐙', '🔥',
  '⭐', '💡', '🎯', '📝', '🧠', '🏷️', '🎨', '🛰️', '🧰', '🦄'
]

const ICON_PX = 64

/** Load an image file and re-encode it as a centered 64×64 PNG data URL,
 *  keeping aspect ratio so the stored icon stays tiny. */
function fileToIcon(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read failed'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('decode failed'))
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = ICON_PX
        canvas.height = ICON_PX
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('no canvas context'))
        const scale = Math.min(ICON_PX / img.width, ICON_PX / img.height)
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        ctx.drawImage(img, Math.round((ICON_PX - w) / 2), Math.round((ICON_PX - h) / 2), w, h)
        resolve(canvas.toDataURL('image/png'))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

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
  const [icon, setIcon] = useState<string | undefined>(project?.icon)
  const [description, setDescription] = useState(project?.description ?? '')
  const [group, setGroup] = useState(project?.group ?? '')
  const [tags, setTags] = useState<string[]>(project?.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [iconError, setIconError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const isImageIcon = !!icon && icon.startsWith('data:')

  const addTag = (): void => {
    const t = tagInput.trim().toLowerCase()
    if (t && !tags.includes(t)) setTags([...tags, t])
    setTagInput('')
  }

  const handleIconFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    setIconError(null)
    try {
      setIcon(await fileToIcon(file))
    } catch {
      setIconError('Could not read that image.')
    }
  }

  const save = (): void => {
    if (!name.trim()) return
    const base: Project = project ?? {
      id: newId(),
      name: '',
      description: '',
      group: '',
      tags: [],
      repositories: [],
      servers: [],
      databases: [],
      createdAt: Date.now(),
      lastOpenedAt: 0
    }
    upsertProject({
      ...base,
      name: name.trim(),
      icon: icon?.trim() || undefined,
      description: description.trim(),
      group: group.trim(),
      tags
    })
    onClose()
  }

  return (
    <Modal title={project ? 'Edit project' : 'New project'} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name">
          <Input autoFocus placeholder="My project" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Icon" hint="Optional. Pick an emoji, paste one, or upload an image (resized to 64×64).">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-bg-elevated">
                <ProjectIcon icon={icon} size={isImageIcon ? 44 : 26} className="text-ink-faint" />
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink-soft hover:bg-bg-hover hover:text-ink"
                >
                  <Upload size={13} /> Upload image
                </button>
                {icon && (
                  <button
                    type="button"
                    onClick={() => {
                      setIcon(undefined)
                      setIconError(null)
                    }}
                    className="h-8 rounded-md border border-line px-2.5 text-[12px] font-semibold text-ink-soft hover:bg-bg-hover hover:text-bad"
                  >
                    Remove
                  </button>
                )}
                {iconError && <span className="text-[11px] text-bad">{iconError}</span>}
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/*"
              className="hidden"
              onChange={handleIconFile}
            />
            <div className="flex flex-wrap gap-1.5">
              {PROJECT_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setIcon(e)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-md border text-[17px] leading-none transition-transform hover:scale-110',
                    icon === e ? 'border-accent bg-accent-dim' : 'border-line hover:bg-bg-hover'
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
            <Input
              value={isImageIcon ? '' : icon ?? ''}
              onChange={(e) => setIcon(e.target.value || undefined)}
              placeholder="Or paste any emoji…"
              className="max-w-[160px]"
            />
          </div>
        </Field>

        <Field label="Description">
          <textarea
            className="field-input min-h-[64px] resize-none"
            placeholder="What is this project about?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

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
