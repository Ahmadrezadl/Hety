import type { ColumnRef, DbSchema, RowChanges } from '@shared/types'

/** Raw query output from a driver, before cell-value normalisation. */
export interface RawResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  command?: string
  statements?: { command: string; rowCount: number }[]
}

/** A live, engine-specific connection exposing the operations the app needs. */
export interface DbDriver {
  query(sql: string): Promise<RawResult>
  /** Isolated AI analysis, with database-enforced read-only protection. */
  queryReadOnly?(sql: string): Promise<RawResult>
  /** Immediately interrupt an isolated connection, including an active query. */
  abort?(): void
  introspect(): Promise<DbSchema>
  /** Fetch the row(s) a foreign-key value points at. Identifiers are quoted by the driver. */
  lookupRows(ref: ColumnRef, value: unknown, limit: number): Promise<RawResult>
  applyChanges(
    table: string,
    changes: RowChanges
  ): Promise<{ inserted: number; updated: number; deleted: number }>
  setReadOnly(readOnly: boolean): Promise<void>
  version(): Promise<string>
  close(): Promise<void>
}

export interface ConnectParams {
  host: string
  port: number
  database: string
  username: string
  password: string
  /** Bound isolated AI sessions; ordinary interactive connections are unaffected. */
  readOnly?: boolean
  timeoutMs?: number
  /** Fired for idle disconnects / background errors that would otherwise crash the process. */
  onIdleError?: (err: Error) => void
}
