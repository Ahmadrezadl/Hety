import type { Database, Server } from '@shared/types'
import { getDatabaseKindInfo } from '@shared/databases'
import { openConnection, cellToValue, type Connection } from '../ipc/db'
import { analysisSql } from './codexSql'

export interface DatabaseInspection { schema?: string; table?: string }
export const ANALYSIS_DATABASE_KINDS = ['postgresql', 'mysql', 'mariadb', 'clickhouse'] as const

/** A fresh connection per operation: never unlock/reuse the user's DB session. */
export async function inspectDatabase(db: Database, server: Server | undefined, input: DatabaseInspection & { sql?: unknown }, signal: AbortSignal): Promise<object> {
  const querying = input.sql !== undefined
  const kind = getDatabaseKindInfo(db.kind).kind
  if (querying && !(ANALYSIS_DATABASE_KINDS as readonly string[]).includes(kind)) throw new Error(`Read-only AI queries are available for PostgreSQL, MySQL, MariaDB and ClickHouse. ${db.kind} supports schema inspection only.`)
  const sql = querying ? analysisSql(input.sql) : undefined
  for (const filter of [input.schema, input.table]) if (filter !== undefined && (typeof filter !== 'string' || filter.length > 256)) throw new Error('Invalid schema/table filter.')
  if (signal.aborted) throw new Error('Database operation stopped.')
  const controller = new AbortController()
  let connection: Connection | undefined
  let failure = 'Database operation stopped.'
  const stop = (): void => controller.abort()
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(() => { failure = 'Database operation timed out after 45 seconds. Narrow the query or schema filter.'; stop() }, 45000)
  let rejectStopped: (error: Error) => void = () => undefined
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject })
  const onAbort = (): void => {
    connection?.tunnel?.close()
    connection?.driver.abort?.()
    if (connection && !connection.driver.abort) void connection.driver.close().catch(() => undefined)
    rejectStopped(new Error(failure))
  }
  controller.signal.addEventListener('abort', onAbort, { once: true })
  const started = Date.now()
  try {
    return await Promise.race([stopped, (async () => {
      connection = await openConnection(db, server, () => { failure = 'Database connection was lost.'; stop() }, { signal: controller.signal, readOnly: true })
      if (controller.signal.aborted) { onAbort(); throw new Error(failure) }
      if (sql) {
        if (!connection.driver.queryReadOnly) throw new Error('This database driver cannot enforce read-only AI queries.')
        const result = await connection.driver.queryReadOnly(sql)
        const rows: (string | number | boolean | null)[][] = []
        let bytes = Buffer.byteLength(JSON.stringify(result.columns)), truncated = result.rows.length > 200
        for (const row of result.rows.slice(0, 200)) {
          const normalized = row.map(cellToValue)
          const size = Buffer.byteLength(JSON.stringify(normalized))
          if (bytes + size > 120000) { truncated = true; break }
          bytes += size; rows.push(normalized)
        }
        return { database: db.name, kind: db.kind, columns: result.columns, rows, returnedRowCount: rows.length, truncated, elapsedMs: Date.now() - started, readOnly: true, note: 'At most 200 result rows / 120 KB. This is not a source-row count. Aggregate queries use all matching source rows.' }
      }
      const schema = await connection.driver.introspect()
      let totalRelations = 0, returnedRelations = 0, bytes = 0
      const schemas = schema.schemas.filter((ns) => !input.schema || ns.name === input.schema).map((ns) => {
        const select = (tables: typeof ns.tables): typeof ns.tables => tables.filter((table) => !input.table || table.name === input.table).filter((table) => {
          totalRelations++
          const size = Buffer.byteLength(JSON.stringify(table))
          if (returnedRelations >= 100 || bytes + size > 120000) return false
          returnedRelations++; bytes += size; return true
        })
        return { name: ns.name, tables: select(ns.tables), views: select(ns.views) }
      }).filter((ns) => ns.tables.length || ns.views.length)
      return { database: db.name, kind, canQuery: (ANALYSIS_DATABASE_KINDS as readonly string[]).includes(kind), schemas, totalRelations, returnedRelations, truncated: totalRelations > returnedRelations, note: 'Use exact schema and table filters for detailed inspection if truncated. Use schema-qualified table names in queries.' }
    })()])
  } catch (error) {
    let message = (error as Error).message
    for (const secret of [db.password, server?.password, server?.keyPassphrase]) if (secret) message = message.split(secret).join('[redacted]')
    throw new Error(message)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    controller.signal.removeEventListener('abort', onAbort)
    connection?.tunnel?.close()
    if (connection) void connection.driver.close().catch(() => undefined)
  }
}
