import { useState, type ReactNode } from 'react'
import { FileKey } from 'lucide-react'
import type { Server, AuthType } from '@shared/types'
import { useApp, newId } from '../../store'
import { Button, Field, Input, Modal, ColorPicker } from '../../lib/ui'

export default function ServerDialog({
  projectId,
  server,
  onClose
}: {
  projectId: string
  server?: Server
  onClose: () => void
}): ReactNode {
  const upsertServer = useApp((s) => s.upsertServer)

  const [name, setName] = useState(server?.name ?? '')
  const [host, setHost] = useState(server?.host ?? '')
  const [port, setPort] = useState(server?.port ?? 22)
  const [username, setUsername] = useState(server?.username ?? '')
  const [authType, setAuthType] = useState<AuthType>(server?.authType ?? 'password')
  const [password, setPassword] = useState(server?.password ?? '')
  const [keyPath, setKeyPath] = useState(server?.keyPath ?? '')
  const [keyPassphrase, setKeyPassphrase] = useState(server?.keyPassphrase ?? '')
  const [color, setColor] = useState<string | undefined>(server?.color)

  const save = (): void => {
    if (!name.trim() || !host.trim()) return
    upsertServer(projectId, {
      id: server?.id ?? newId(),
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authType,
      password,
      keyPath,
      keyPassphrase,
      color
    })
    onClose()
  }

  const browseKey = async (): Promise<void> => {
    const p = await window.api.app.pickFile()
    if (p) setKeyPath(p)
  }

  return (
    <Modal title={server ? 'Edit server' : 'Add SSH server'} onClose={onClose}>
      <div className="space-y-4">
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
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
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
              <Input
                type="password"
                value={keyPassphrase}
                onChange={(e) => setKeyPassphrase(e.target.value)}
              />
            </Field>
          </>
        )}

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
