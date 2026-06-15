import type { DatabaseKind } from '@shared/databases'
import { dialectOf } from '@shared/sql'
import type { ConnectParams, DbDriver } from './types'
import { createPostgres } from './postgres'
import { createMysql } from './mysql'
import { createSqlServer } from './sqlserver'
import { createClickHouse } from './clickhouse'

export type { DbDriver, ConnectParams, RawResult } from './types'

export function createDriver(kind: DatabaseKind | string, params: ConnectParams): Promise<DbDriver> {
  switch (dialectOf(kind)) {
    case 'mysql':
      return createMysql(params, kind === 'mariadb' ? 'MariaDB' : 'MySQL')
    case 'sqlserver':
      return createSqlServer(params)
    case 'clickhouse':
      return createClickHouse(params)
    default:
      return createPostgres(params)
  }
}
