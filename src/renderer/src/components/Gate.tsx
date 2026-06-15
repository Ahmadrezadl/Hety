import { useEffect, useState, type ReactNode } from 'react'
import { Lock, ShieldCheck, Hexagon } from 'lucide-react'
import { useApp } from '../store'
import { Button, Input, Spinner } from '../lib/ui'

export default function Gate(): ReactNode {
  const load = useApp((s) => s.load)
  const [phase, setPhase] = useState<'loading' | 'unlock' | 'create'>('loading')
  const [password, setPassword] = useState('')
  const [encrypt, setEncrypt] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.store.getStatus().then(async ({ exists, encrypted }) => {
      if (!exists) {
        setPhase('create')
      } else if (encrypted) {
        setPhase('unlock')
      } else {
        const r = await window.api.store.unlock(null)
        if (r.ok && r.data) load(r.data)
        else setPhase('unlock')
      }
    })
  }, [load])

  const doUnlock = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await window.api.store.unlock(password)
    setBusy(false)
    if (r.ok && r.data) load(r.data)
    else setError(r.ok ? 'Empty data' : r.error)
  }

  const doCreate = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await window.api.store.create(encrypt ? password : null)
    setBusy(false)
    if (r.ok && r.data) load(r.data)
    else setError(r.ok ? 'Failed' : r.error)
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg-base">
      <div className="w-[380px] rounded-2xl border border-line bg-bg-panel p-7 shadow-2xl">
        <div className="mb-5 flex items-center gap-2.5">
          <Hexagon className="text-accent" size={26} fill="currentColor" fillOpacity={0.15} />
          <div>
            <div className="text-xl font-extrabold tracking-tight">Hety</div>
            <div className="text-[11px] text-ink-faint">SSH · Git · PostgreSQL cockpit</div>
          </div>
        </div>

        {phase === 'loading' && (
          <div className="flex items-center gap-2 py-6 text-ink-soft">
            <Spinner /> Loading…
          </div>
        )}

        {phase === 'unlock' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-ink-soft">
              <Lock size={15} /> Your data is encrypted.
            </div>
            <Input
              type="password"
              autoFocus
              placeholder="Master password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doUnlock()}
            />
            {error && <div className="text-xs text-bad">{error}</div>}
            <Button className="w-full" disabled={busy} onClick={doUnlock}>
              {busy ? <Spinner /> : 'Unlock'}
            </Button>
          </div>
        )}

        {phase === 'create' && (
          <div className="space-y-3">
            <div className="text-sm text-ink-soft">Welcome. Set up your workspace.</div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={encrypt}
                onChange={(e) => setEncrypt(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={15} /> Encrypt with a master password
              </span>
            </label>
            {encrypt && (
              <Input
                type="password"
                autoFocus
                placeholder="Choose a master password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doCreate()}
              />
            )}
            {error && <div className="text-xs text-bad">{error}</div>}
            <Button
              className="w-full"
              disabled={busy || (encrypt && !password)}
              onClick={doCreate}
            >
              {busy ? <Spinner /> : 'Get started'}
            </Button>
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Encryption uses AES-256-GCM. Without a password your data is stored unencrypted on this
              machine.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
