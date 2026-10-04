import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Check } from 'lucide-react'

export function CodeBlock({ code, language }: { code: string; language?: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return <div className="my-3 min-w-0 overflow-hidden rounded-lg border border-line bg-bg-input">
    <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[11px] text-ink-faint">
      <span>{language || 'Code'}</span>
      <button type="button" className="flex items-center gap-1.5 hover:text-ink" aria-label="Copy code" onClick={async () => {
        try { await navigator.clipboard.writeText(code); setCopied(true); setFailed(false) } catch { setFailed(true) }
      }}>{copied ? <Check size={12} /> : <Copy size={12} />}{failed ? 'Copy failed' : copied ? 'Copied' : 'Copy'}</button>
    </div>
    <pre className="max-h-[32rem] select-text overflow-auto p-3 font-mono text-[12px] leading-5"><code className="whitespace-pre">{code}</code></pre>
  </div>
}

export default function ChatMarkdown({ text }: { text: string }): ReactNode {
  return <div className="min-w-0 select-text break-words text-[13px] leading-6">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      pre: ({ children }) => <>{children}</>,
      code: ({ children, className }) => {
        const code=String(children)
        return className || code.endsWith('\n') ? <CodeBlock code={code.replace(/\n$/,'')} language={className?.replace(/^language-/,'')} /> : <code className="rounded bg-bg-input px-1.5 py-0.5 font-mono text-[12px] text-accent-hover">{children}</code>
      },
      p: ({ children }) => <p className="my-2 whitespace-pre-wrap">{children}</p>,
      ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>,
      ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>,
      h1: ({ children }) => <h2 className="my-3 text-lg font-semibold">{children}</h2>,
      h2: ({ children }) => <h3 className="my-3 text-base font-semibold">{children}</h3>,
      h3: ({ children }) => <h4 className="my-2 font-semibold">{children}</h4>,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-hover underline underline-offset-2">{children}</a>,
      blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-accent pl-3 text-ink-soft">{children}</blockquote>,
      table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-xs">{children}</table></div>,
      th: ({ children }) => <th className="border border-line bg-bg-elevated px-3 py-2 text-left">{children}</th>,
      td: ({ children }) => <td className="border border-line px-3 py-2">{children}</td>,
      img: ({ alt }) => <span className="text-ink-faint">[Image: {alt || 'attachment'}]</span>
    }}>{text}</ReactMarkdown>
  </div>
}
