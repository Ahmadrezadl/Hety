import type { ReactNode } from 'react'
import type { DatabaseKind } from '@shared/databases'
import { getDatabaseKindInfo } from '@shared/databases'

const LOGO_STYLE: Record<DatabaseKind, { bg: string; fg: string; mark: string }> = {
  postgresql: { bg: '#336791', fg: '#ffffff', mark: 'PG' },
  mysql: { bg: '#00758f', fg: '#ffffff', mark: 'MY' },
  mariadb: { bg: '#003545', fg: '#ffffff', mark: 'MA' },
  sqlite: { bg: '#0f80cc', fg: '#ffffff', mark: 'SQ' },
  sqlserver: { bg: '#cc2927', fg: '#ffffff', mark: 'MS' },
  clickhouse: { bg: '#ffcc00', fg: '#1a1a1a', mark: 'CH' },
  mongodb: { bg: '#47a248', fg: '#ffffff', mark: 'MO' },
  redis: { bg: '#dc382d', fg: '#ffffff', mark: 'RD' }
}

export default function DatabaseLogo({
  kind,
  size = 32,
  className
}: {
  kind?: DatabaseKind | string
  size?: number
  className?: string
}): ReactNode {
  const info = getDatabaseKindInfo(kind)
  const style = LOGO_STYLE[info.kind]
  const fontSize = size <= 20 ? 8 : size <= 28 ? 10 : 11

  return (
    <span
      className={className}
      title={info.name}
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        background: style.bg,
        color: style.fg,
        fontSize,
        borderRadius: Math.min(8, Math.round(size * 0.22))
      }}
      aria-label={`${info.name} logo`}
    >
      <span
        style={{
          display: 'flex',
          height: '100%',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 800,
          lineHeight: 1
        }}
      >
        {style.mark}
      </span>
    </span>
  )
}
