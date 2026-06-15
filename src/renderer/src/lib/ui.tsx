import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'

export const cn = clsx

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'md' | 'sm'
}
export function Button({ variant = 'primary', size = 'md', className, ...rest }: BtnProps): ReactNode {
  const base =
    variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-ghost'
  return <button className={cn(base, size === 'sm' && 'btn-sm', className)} {...rest} />
}

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { title?: string }
export function IconButton({ className, ...rest }: IconBtnProps): ReactNode {
  return (
    <button
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-bg-hover hover:text-ink transition-colors',
        className
      )}
      {...rest}
    />
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...props} className={cn('field-input', props.className)} />
}

export function Field({
  label,
  children,
  hint
}: {
  label: string
  children: ReactNode
  hint?: string
}): ReactNode {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-semibold text-ink-soft">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-ink-faint">{hint}</div>}
    </label>
  )
}

export function Modal({
  title,
  onClose,
  children,
  width = 520
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}): ReactNode {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="max-h-[88vh] overflow-auto rounded-xl border border-line bg-bg-panel shadow-2xl"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-bold">{title}</h2>
          <IconButton title="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function Chip({
  children,
  active,
  onClick,
  count
}: {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  count?: number
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors',
        active
          ? 'border-accent bg-accent text-white'
          : 'border-line bg-bg-elevated text-ink-soft hover:bg-bg-hover hover:text-ink'
      )}
    >
      {children}
      {count !== undefined && <span className="opacity-60">{count}</span>}
    </button>
  )
}

export function Spinner({ className }: { className?: string }): ReactNode {
  return (
    <span
      className={cn(
        'inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-faint border-t-accent',
        className
      )}
    />
  )
}

export function EmptyState({
  icon,
  title,
  subtitle
}: {
  icon: ReactNode
  title: string
  subtitle?: string
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <div className="text-ink-faint">{icon}</div>
      <div className="text-[15px] font-semibold text-ink-soft">{title}</div>
      {subtitle && <div className="max-w-sm text-xs text-ink-faint">{subtitle}</div>}
    </div>
  )
}

export function StatusDot({ color }: { color: string }): ReactNode {
  return <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
}

export const COLOR_SWATCHES = [
  '#e0625e',
  '#e0883c',
  '#e0b341',
  '#46c08a',
  '#56c7d6',
  '#6d8cff',
  '#b07ee6',
  '#9aa1ad'
]

export function ColorPicker({
  value,
  onChange
}: {
  value?: string
  onChange: (c?: string) => void
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        title="None"
        onClick={() => onChange(undefined)}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border text-[11px]',
          !value ? 'border-accent text-ink' : 'border-line text-ink-faint'
        )}
      >
        ⦸
      </button>
      {COLOR_SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          onClick={() => onChange(c)}
          style={{ background: c }}
          className={cn(
            'h-6 w-6 rounded-full border-2 transition-transform hover:scale-110',
            value === c ? 'border-white' : 'border-transparent'
          )}
        />
      ))}
    </div>
  )
}
