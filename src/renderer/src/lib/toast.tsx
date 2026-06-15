import { create } from 'zustand'
import { type ReactNode } from 'react'
import { X, AlertCircle, CheckCircle2, Info } from 'lucide-react'
import { cn } from './ui'

type Kind = 'error' | 'success' | 'info'
interface ToastItem {
  id: string
  kind: Kind
  text: string
}
interface ToastState {
  toasts: ToastItem[]
  push: (kind: Kind, text: string) => void
  dismiss: (id: string) => void
}

const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = crypto.randomUUID()
    // Keep at most a handful on screen.
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }))
    const ttl = kind === 'error' ? 7000 : 3000
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ttl)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** Fire-and-forget toasts from anywhere (no hook needed). */
export const toast = {
  error: (text: string): void => useToasts.getState().push('error', text),
  success: (text: string): void => useToasts.getState().push('success', text),
  info: (text: string): void => useToasts.getState().push('info', text)
}

export function Toaster(): ReactNode {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[200] flex w-[360px] max-w-[90vw] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cn(
            'pointer-events-auto flex cursor-pointer items-start gap-2 rounded-lg border border-l-4 border-line bg-bg-elevated px-3 py-2.5 text-[13px] text-ink shadow-2xl',
            t.kind === 'error'
              ? 'border-l-bad'
              : t.kind === 'success'
                ? 'border-l-ok'
                : 'border-l-accent'
          )}
        >
          <span
            className={cn(
              'mt-0.5 shrink-0',
              t.kind === 'error' ? 'text-bad' : t.kind === 'success' ? 'text-ok' : 'text-accent'
            )}
          >
            {t.kind === 'error' ? (
              <AlertCircle size={15} />
            ) : t.kind === 'success' ? (
              <CheckCircle2 size={15} />
            ) : (
              <Info size={15} />
            )}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{t.text}</span>
          <button className="shrink-0 text-ink-faint hover:text-ink" title="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
