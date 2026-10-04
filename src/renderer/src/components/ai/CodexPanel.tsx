import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Sparkles, RefreshCw, Send, Square, FolderOpen, Plus, CheckCircle2, AlertCircle, Copy, Paperclip, X } from 'lucide-react'
import type { Project, Database as DatabaseConnection } from '@shared/types'
import { projectCodexContext, hasCurrentHetyTools, HETY_REQUIRED_TOOLS, type CodexStatus, type CodexMessage, type DatabaseApproval, type WriteApproval, type CodexAttachment } from '@shared/codex'
import { defaultCodexAccess, type CodexAccess } from '@shared/codexAccess'
import { Button, cn } from '../../lib/ui'
import { useApp } from '../../store'
import DatabaseProposal from './DatabaseProposal'
import WriteProposal from './WriteProposal'
import ChatMarkdown from './ChatMarkdown'
import ContextAccessSettings from './ContextAccessSettings'

interface Message extends CodexMessage { id: string; error?: boolean }

function recentHistory(messages: Message[]): CodexMessage[] {
  const history: CodexMessage[] = []
  let length = 0
  for (const message of messages.filter((m) => !m.error).slice(-20).reverse()) {
    const entry = { role: message.role, text: message.text }
    const size = JSON.stringify(entry).length + 1
    if (length + size > 60_000) break
    history.unshift(entry)
    length += size
  }
  return history
}

export default function CodexPanel({ project, visible }: { project: Project; visible: boolean }): ReactNode {
  const [status, setStatus] = useState<CodexStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [repositoryId, setRepositoryId] = useState('')
  const [folder, setFolder] = useState('')
  const [savedAccess, setSavedAccess] = useState<CodexAccess>(() => {
    try { return defaultCodexAccess(project, JSON.parse(localStorage.getItem(`hety.codex.access.${project.id}`) ?? 'null')) } catch { return defaultCodexAccess(project) }
  })
  const access = defaultCodexAccess(project, savedAccess)
  const accessSignature = JSON.stringify(access)
  const [attachments,setAttachments]=useState<CodexAttachment[]>([])
  const [attaching,setAttaching]=useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [activity, setActivity] = useState('')
  const [toolConnection, setToolConnection] = useState('')
  const [error, setError] = useState('')
  const [showContext, setShowContext] = useState(false)
  const [copied, setCopied] = useState(false)
  const [approval, setApproval] = useState<DatabaseApproval | null>(null)
  const [writeApproval,setWriteApproval]=useState<WriteApproval | null>(null)
  const [approving, setApproving] = useState(false)
  const runId = useRef<string | null>(null)
  const historyStart = useRef(0)
  const mounted = useRef(true)
  const checkingRef = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const repositories = project.repositories
  const repository = repositories.find((r) => r.id === repositoryId && access.repositories[r.id] !== 'excluded')
  const cwd = repository?.path ?? (repositoryId === '__folder__' && access.localFolder !== 'excluded' ? folder : '')
  const localMode = repository ? access.repositories[repository.id] : access.localFolder
  const allowEdits = localMode === 'approval' || localMode === 'full'
  const context = JSON.stringify(projectCodexContext(project, access), null, 2)

  async function check(force = false): Promise<void> {
    if (checkingRef.current) return
    checkingRef.current = true
    setChecking(true)
    try {
      const result = await window.api.codex.status(force)
      if (mounted.current) setStatus(result)
    } catch (e) {
      if (mounted.current) setStatus({ installed: false, authenticated: false, message: (e as Error).message })
    } finally {
      checkingRef.current = false
      if (mounted.current) setChecking(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    const off = window.api.codex.onEvent((event) => {
      if (event.projectId !== project.id || event.runId !== runId.current) return
      if (event.type === 'message') {
        setMessages((previous) => [...previous, { id: crypto.randomUUID(), role: 'assistant', text: event.text ?? '' }])
      } else if (event.type === 'activity') {
        setActivity(event.text ?? 'Working…')
      } else if (event.type === 'tools') {
        setToolConnection(HETY_REQUIRED_TOOLS.every((name) => event.tools?.includes(name)) ? 'Codex loaded Hety tools · SQL queries available' : 'Some Hety tools are missing. Restart Hety.')
      } else if (event.type === 'error') {
        setMessages((previous) => [...previous, { id: crypto.randomUUID(), role: 'assistant', text: event.text ?? 'Codex run failed.', error: true }])
      } else if (event.type === 'approval') {
        setApproval(event.approval ?? null)
        setWriteApproval(event.writeApproval ?? null)
      } else if (event.type === 'done') {
        runId.current = null
        setRunning(false)
        setStopping(false)
        setApproval(null)
        setWriteApproval(null)
        setActivity(event.cancelled ? 'Run stopped.' : event.success ? 'Completed.' : 'Run failed. You can retry below.')
        setToolConnection((current) => current.startsWith('Connecting') ? event.cancelled ? 'Tool connection stopped.' : 'Codex did not load Hety tools.' : current)
      }
    })
    return () => {
      mounted.current = false
      off()
      if (runId.current) void window.api.codex.cancel(runId.current)
    }
  }, [project.id])

  useEffect(() => { if (visible) { void check(); textarea.current?.focus() } }, [visible])
  useEffect(() => {
    if (scroll.current && visible) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [messages, activity, approval, writeApproval, visible])
  useEffect(() => {
    try { localStorage.setItem(`hety.codex.access.${project.id}`, accessSignature) } catch { /* Still usable for this session. */ }
    // Don't resend previously disclosed resource data after access changes.
    historyStart.current = messages.length
  }, [accessSignature, project.id])

  async function send(): Promise<void> {
    if (runId.current || !prompt.trim() || !status?.authenticated || !hasCurrentHetyTools(status) || checking) return
    const text = prompt.trim()
    const id = crypto.randomUUID()
    runId.current = id
    setRunning(true)
    setStopping(false)
    setError('')
    setActivity('Starting Codex…')
    setToolConnection('Connecting Codex to Hety tools…')
    setPrompt('')
    setMessages((previous) => [...previous, { id, role: 'user', text }])
    try {
      const result = await window.api.codex.start({
        runId: id, projectId: project.id, repositoryId: repository?.id,
        folder: repository || !cwd ? undefined : folder, prompt: text,
        history: recentHistory(messages.slice(historyStart.current)), allowEdits: !!cwd && allowEdits,
        access, attachments
      })
      if (!result.ok) throw new Error(result.error)
    } catch (e) {
      if (!mounted.current || runId.current !== id) return
      runId.current = null
      setRunning(false)
      setStopping(false)
      setActivity('')
      setToolConnection('')
      setError((e as Error).message)
      setPrompt(text)
      setMessages((previous) => previous.filter((m) => m.id !== id))
    }
  }

  async function decideWrite(approve:boolean):Promise<void> {
    if(!writeApproval || !runId.current || approving)return
    setApproving(true);setError('')
    try {
      const result=await window.api.codex.approveWrite({runId:runId.current,id:writeApproval.id,approve})
      if(!result.ok)throw new Error(result.error)
    } catch(error){setError((error as Error).message)}
    finally{setApproving(false)}
  }
  async function attach():Promise<void> {
    if(running || attaching)return
    setAttaching(true);setError('')
    try {
      const picked=await window.api.app.pickFile();if(!picked)return
      const result=await window.api.codex.attachment(picked);if(!result.ok)throw new Error(result.error)
      setAttachments((current) => current.some((file) => file.id===result.data!.id) ? current : [...current,result.data!].slice(0,20))
    }catch(error){setError((error as Error).message)}
    finally{setAttaching(false)}
  }

  async function decide(database: DatabaseConnection | null): Promise<void> {
    if (!approval || !runId.current || approving) return
    setApproving(true)
    setError('')
    try {
      const result = await window.api.codex.approveDatabase({ runId: runId.current, id: approval.id, approve: database !== null, database: database ?? undefined })
      if (!result.ok) throw new Error(result.error)
      if (result.data) useApp.getState().load(result.data)
      setApproval(null)
      setActivity(database ? 'Database added to this project.' : 'Database was not added.')
    } catch (error) { setError((error as Error).message) }
    finally { setApproving(false) }
  }

  async function stop(): Promise<void> {
    if (!runId.current) return
    setStopping(true)
    try {
      const result = await window.api.codex.cancel(runId.current)
      if (!result.ok) throw new Error(result.error)
    } catch (e) {
      setError((e as Error).message)
      setStopping(false)
    }
  }

  const outdatedBackend = !!status?.installed && !hasCurrentHetyTools(status)
  const ready = status?.installed && status.authenticated && !outdatedBackend
  const suggestions = ['Analyze the minimum, maximum, median and average submitted scores in the production database', 'Find the production database and propose adding it to this project', 'Explain this project and its services']

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-dim text-accent-hover"><Sparkles size={19} /></div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Codex for {project.name}</div>
            <div className="flex items-center gap-1.5 text-xs text-ink-soft">
              {checking ? <RefreshCw size={12} className="animate-spin" /> : ready ? <CheckCircle2 size={12} className="text-ok" /> : <AlertCircle size={12} />}
              {checking ? 'Checking Codex…' : outdatedBackend ? 'Restart Hety to load updated tools' : ready ? `${status.version ?? 'Codex CLI'} · Signed in · SQL tools enabled` : status?.installed ? 'Codex found · Sign-in required' : 'Codex CLI not found'}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void check(true)} disabled={checking || running} title="Check Codex installation and sign-in"><RefreshCw size={13} /> Check</Button>
          <Button size="sm" variant="ghost" disabled={running || messages.length === 0} onClick={() => { historyStart.current = 0; setMessages([]); setActivity(''); setToolConnection(''); setError('') }}><Plus size={13} /> New chat</Button>
        </header>

        {status?.message && <div className="mx-5 mt-4 rounded-lg border border-line bg-bg-elevated p-3 text-xs text-ink-soft">{status.message}</div>}
        {outdatedBackend && <div role="alert" className="mx-5 mt-4 rounded-lg border border-bad/40 bg-bad/5 p-3 text-xs text-bad">Hety’s chat interface was updated, but its running backend has older tools. Fully quit and reopen Hety to enable SQL queries and approval-based writes.</div>}
        {toolConnection && <div role="status" className="mx-5 mt-3 text-[11px] text-ink-soft">{toolConnection}</div>}

        <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-5" aria-live="polite">
          {messages.length === 0 ? (
            <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-4 text-center">
              <Sparkles size={34} className="text-accent-hover" />
              <div><h2 className="text-xl font-semibold">Work with your Hety project</h2><p className="mt-2 text-sm leading-6 text-ink-soft">Choose the resources Codex can use in Context & access. Read only blocks changes, Approve changes asks before each write, and Full access allows changes without asking. A working folder is optional.</p></div>
              <div className="mt-2 flex w-full flex-col gap-2">
                {suggestions.map((suggestion) => <button key={suggestion} className="rounded-lg border border-line bg-bg-elevated px-4 py-3 text-left text-xs text-ink-soft hover:border-accent hover:text-ink" onClick={() => { setPrompt(suggestion); textarea.current?.focus() }}>{suggestion}</button>)}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              {messages.map((message) => <article key={message.id} className={cn('rounded-xl border p-4', message.error ? 'border-bad/40 bg-bad/5' : message.role === 'user' ? 'border-line bg-bg-elevated' : 'border-transparent')}>
                <div className={cn('mb-2 text-xs font-semibold', message.error ? 'text-bad' : message.role === 'user' ? 'text-ink-soft' : 'text-accent-hover')}>{message.role === 'user' ? 'You' : 'Codex'}</div>
                <ChatMarkdown text={message.text} />
              </article>)}
              {activity && <div role="status" className="flex items-start gap-2 break-all text-xs text-ink-faint">{running && <RefreshCw size={13} className="mt-0.5 shrink-0 animate-spin" />}<span>{activity}</span></div>}
              {approval && <DatabaseProposal key={approval.id} approval={approval} project={project} busy={approving} onDecision={(database) => void decide(database)} />}
              {writeApproval && <WriteProposal key={writeApproval.id} approval={writeApproval} busy={approving} onDecision={(approve) => void decideWrite(approve)} />}
            </div>
          )}
        </div>

        <footer className="border-t border-line px-5 py-4">
          {error && <div role="alert" className="mb-3 text-xs text-bad">{error}</div>}
          <div className="rounded-xl border border-line bg-bg-input p-3 focus-within:border-accent">
            {attachments.length>0 && <div className="mb-2 flex flex-wrap gap-2">{attachments.map((file) => <div key={file.id} className="flex max-w-full items-center gap-2 rounded-md border border-line px-2 py-1 text-[11px] text-ink-soft"><Paperclip size={11}/><span className="truncate" title={file.path}>{file.name} · {Math.ceil(file.size/1024)} KB</span><button type="button" aria-label={`Remove ${file.name}`} disabled={running} onClick={() => setAttachments((current) => current.filter((f) => f.id!==file.id))}><X size={12}/></button></div>)}</div>}
            <textarea ref={textarea} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={32_000} rows={3} aria-label="Prompt Codex" placeholder="Ask Codex about this project…" className="w-full resize-none bg-transparent text-[13px] leading-6 outline-none placeholder:text-ink-faint" onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
            }} />
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-3"><Button size="sm" variant="ghost" disabled={running || attaching || attachments.length>=20} onClick={() => void attach()}><Paperclip size={13}/>{attaching ? 'Attaching…' : 'Attach file'}</Button><span className="text-[11px] text-ink-faint">Ctrl / ⌘ + Enter</span></div>
              {running ? <Button size="sm" variant="ghost" onClick={() => void stop()} disabled={stopping}><Square size={12} />{stopping ? 'Stopping…' : 'Stop'}</Button> : <Button size="sm" onClick={() => void send()} disabled={!ready || checking || attaching || !prompt.trim()}><Send size={13} /> Send to Codex</Button>}
            </div>
          </div>
        </footer>
      </section>

      <aside aria-label="Codex context and access settings" className="w-[340px] shrink-0 overflow-y-auto border-l border-line bg-bg-panel p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-soft">Local files (optional)</h3>
        <select aria-label="Codex working repository" className="field-input" value={repository?.id ?? (repositoryId === '__folder__' ? '__folder__' : '')} disabled={running} onChange={(event) => setRepositoryId(event.target.value)}>
          <option value="">Hety tools only</option>
          {repositories.filter((repo) => access.repositories[repo.id] !== 'excluded').map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
          <option value="__folder__">Choose another folder</option>
        </select>
        {repositoryId === '__folder__' && <Button className="mt-2 w-full" size="sm" variant="ghost" disabled={running} onClick={async () => {
          try { const picked = await window.api.app.pickFolder(); if (picked) { setFolder(picked); setError('') } } catch (e) { setError((e as Error).message) }
        }}><FolderOpen size={14} /> Browse folder</Button>}
        <div className="mt-2 select-text break-all text-[11px] leading-5 text-ink-faint">{cwd || 'Ready for server and project tasks without a folder.'}</div>
        <div className="my-5 border-t border-line" />
        <ContextAccessSettings project={project} access={access} disabled={running} customFolder={repositoryId === '__folder__'} onChange={setSavedAccess} />
        <p className="mt-4 text-[10px] leading-5 text-ink-faint">Saved credentials stay inside Hety. A database may use an excluded server internally as its SSH tunnel; direct access to that server stays blocked. Adding a database to the project always asks for review.</p>
        <Button size="sm" variant="ghost" className="mt-1 w-full" onClick={() => setShowContext(!showContext)}>{showContext ? 'Hide' : 'Preview'} sent context</Button>
        {showContext && <div className="mt-3">
          <Button size="sm" variant="ghost" className="mb-2" onClick={async () => {
            try { await navigator.clipboard.writeText(context); setCopied(true) } catch { setError('Could not copy project context.') }
          }}><Copy size={12} />{copied ? 'Copied' : 'Copy context'}</Button>
          <pre className="max-h-96 select-text overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-input p-3 text-[10px] leading-5 text-ink-soft">{context}</pre>
        </div>}
        {status?.executable && <div className="mt-5 select-text break-all text-[10px] leading-5 text-ink-faint">Codex: {status.executable}</div>}
      </aside>
    </div>
  )
}
