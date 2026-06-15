import type { QueryResult } from '@shared/types'

export function cellString(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

function escapeCsv(s: string, delimiter: string): string {
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

export function toDelimited(result: QueryResult, delimiter: string): string {
  const head = result.columns.map((c) => escapeCsv(c, delimiter)).join(delimiter)
  const body = result.rows
    .map((row) => row.map((v) => escapeCsv(cellString(v), delimiter)).join(delimiter))
    .join('\n')
  return body ? `${head}\n${body}` : head
}

export function toCsv(result: QueryResult): string {
  return toDelimited(result, ',')
}

export function toTsv(result: QueryResult): string {
  return toDelimited(result, '\t')
}

export function toMarkdown(result: QueryResult): string {
  const cols = result.columns
  if (!cols.length) return ''
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const header = `| ${cols.map(esc).join(' | ')} |`
  const sep = `| ${cols.map(() => '---').join(' | ')} |`
  const rows = result.rows.map((row) => `| ${row.map((v) => esc(cellString(v))).join(' | ')} |`)
  return [header, sep, ...rows].join('\n')
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
