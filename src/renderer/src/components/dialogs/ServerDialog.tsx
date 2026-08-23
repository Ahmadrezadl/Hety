import { useState, type ReactNode } from 'react'
import { FileKey } from 'lucide-react'
import type { Server, AuthType } from '@shared/types'
import { useApp, newId } from '../../store'
import { Button, Field, Input, PasswordInput, Modal, ColorPicker, ConfigActions } from '../../lib/ui'
import { copyText } from '../../lib/format'
import { toast } from '../../lib/toast'

export default function ServerDialog({
  projectId,
  server,
  duplicateFrom,
  onClose
}: {
  projectId: string
  server?: Server
  duplicateFrom?: Server
  onClose: () => void
}): ReactNode {
  const upsertServer = useApp((s) => s.upsertServer)
  const source = server ?? duplicateFrom
  const isEdit = !!server

  const [name, setName] = useState(
    duplicateFrom ? `${duplicateFrom.name} (copy)` : (server?.name ?? '')
  )
  const [host, setHost] = useState(source?.host ?? '')
  const [port, setPort] = useState(source?.port ?? 22)
  const [username, setUsername] = useState(source?.username ?? '')
  const [authType, setAuthType] = useState<AuthType>(source?.authType ?? 'password')
  const [password, setPassword] = useState(source?.password ?? '')
  const [keyPath, setKeyPath] = useState(source?.keyPath ?? '')
  const [keyPassphrase, setKeyPassphrase] = useState(source?.keyPassphrase ?? '')
  const [sudoPassword, setSudoPassword] = useState(source?.sudoPassword ?? '')
  const [color, setColor] = useState<string | undefined>(source?.color)

  const save = (): void => {
    if (!name.trim() || !host.trim()) return
    upsertServer(projectId, {
      // Spread first so fields this form doesn't edit (snippets) survive a save.
      ...(isEdit ? server : duplicateFrom),
      id: isEdit ? server!.id : newId(),
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authType,
      password,
      keyPath,
      keyPassphrase,
      sudoPassword,
      color
    })
    onClose()
  }

  const browseKey = async (): Promise<void> => {
    const p = await window.api.app.pickFile()
    if (p) setKeyPath(p)
  }

  const copyConfig = async (): Promise<void> => {
    const config = {
      type: 'hety.server',
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authType,
      password,
      keyPath,
      keyPassphrase,
      sudoPassword
    }
    await copyText(JSON.stringify(config, null, 2))
    toast.success('Server config copied to clipboard')
  }

  const pasteConfig = async (): Promise<void> => {
    try {
      const c = JSON.parse(await navigator.clipboard.readText())
      if (!c || typeof c !== 'object') throw new Error('not an object')
      if (typeof c.name === 'string') setName(c.name)
      if (typeof c.host === 'string') setHost(c.host)
      if (c.port !== undefined) setPort(Number(c.port) || 22)
      if (typeof c.username === 'string') setUsername(c.username)
      if (c.authType === 'password' || c.authType === 'key') setAuthType(c.authType)
      if (typeof c.password === 'string') setPassword(c.password)
      if (typeof c.keyPath === 'string') setKeyPath(c.keyPath)
      if (typeof c.keyPassphrase === 'string') setKeyPassphrase(c.keyPassphrase)
      if (typeof c.sudoPassword === 'string') setSudoPassword(c.sudoPassword)
      toast.success('Server config pasted from clipboard')
    } catch {
      toast.error('Clipboard does not contain a valid server config')
    }
  }

  return (
    <Modal title={isEdit ? 'Edit server' : duplicateFrom ? 'Duplicate server' : 'Add SSH server'} onClose={onClose}>
      <div className="space-y-4">
        <ConfigActions onCopy={copyConfig} onPaste={pasteConfig} />
        <Field label="Display name">
          <Input autoFocus placeholder="Production web" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Color" hint="Flag important servers (e.g. red for production).">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <div className="grid grid-cols-[1fr,110px] gap-3">
          <Field label="Host">
            <Input placeholder="example.com" value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <Field label="Port">
            <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Username">
          <Input placeholder="root" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>

        <Field label="Authentication">
          <div className="flex gap-2">
            {(['password', 'key'] as AuthType[]).map((a) => (
              <button
                key={a}
                onClick={() => setAuthType(a)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-semibold ${
                  authType === a
                    ? 'border-accent bg-accent-dim text-ink'
                    : 'border-line bg-bg-input text-ink-soft hover:bg-bg-hover'
                }`}
              >
                {a === 'password' ? 'Password' : 'Private key'}
              </button>
            ))}
          </div>
        </Field>

        {authType === 'password' ? (
          <Field label="Password">
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label="Private key file">
              <div className="flex gap-2">
                <Input placeholder="~/.ssh/id_rsa" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
                <button onClick={browseKey} className="btn-ghost btn shrink-0 px-2" type="button" title="Browse">
                  <FileKey size={15} />
                </button>
              </div>
            </Field>
            <Field label="Key passphrase (optional)">
              <PasswordInput
                value={keyPassphrase}
                onChange={(e) => setKeyPassphrase(e.target.value)}
              />
            </Field>
          </>
        )}

        <Field
          label="Sudo password (optional)"
          hint="Used by the Remote tab for root-only actions — firewall rules, services, protected files. Leave empty to reuse the login password, or if this account is root / passwordless sudo."
        >
          <PasswordInput
            placeholder={authType === 'password' && password ? 'Same as login password' : ''}
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
          />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || !host.trim()} onClick={save}>
            {server ? 'Save' : 'Add server'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
