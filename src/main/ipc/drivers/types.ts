import type { DbSchema, RowChanges } from '@shared/types'

/** Raw query output from a driver, before cell-value normalisation. */
export interface RawResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  command?: string
}

/** A live, engine-specific connection exposing the operations the app needs. */
export interface DbDriver {
  query(sql: string): Promise<RawResult>
  introspect(): Promise<DbSchema>
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
}
