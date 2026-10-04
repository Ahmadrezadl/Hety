import type { ReactNode } from 'react'
import type { WriteApproval } from '@shared/codex'
import { ShieldCheck } from 'lucide-react'
import { Button } from '../../lib/ui'
import { CodeBlock } from './ChatMarkdown'

const TITLES = {database_write:'Database changes',ssh_execute:'Server command',ssh_upload:'File upload to server',http_request:'API changes',http_upload:'File upload to API',local_write:'Local file changes',local_execute:'Local command'}
export default function WriteProposal({ approval, busy, onDecision }: { approval: WriteApproval; busy: boolean; onDecision: (approve:boolean) => void }): ReactNode {
  return <section className="rounded-xl border border-accent/50 bg-bg-panel p-4" aria-label="Write approval">
    <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck size={17} className="text-accent-hover" />Approve {TITLES[approval.kind]}?</h3>
    <div className="mt-3 select-text break-all rounded-lg bg-bg-input px-3 py-2 text-xs">{approval.target}</div>
    <p className="mt-3 text-xs leading-5 text-ink-soft">{approval.reason}</p>
    <CodeBlock code={approval.details} language={approval.language} />
    <p className="text-xs leading-5 text-warn">{approval.warning}</p>
    <p className="mt-2 text-[11px] text-ink-faint">Approve applies only to this action. Future writes will ask again.</p>
    <div className="mt-4 flex justify-end gap-2">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecision(false)}>Don’t apply</Button>
      <Button size="sm" disabled={busy} onClick={() => onDecision(true)}>{busy ? 'Applying…' : 'Approve and apply'}</Button>
    </div>
  </section>
}
