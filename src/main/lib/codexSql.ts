// A deliberately small analysis SQL surface. Database read-only transactions
// remain the write barrier; this also excludes file/network functions and locks.
const FORBIDDEN = new Set(('INSERT UPDATE DELETE MERGE REPLACE CREATE ALTER DROP TRUNCATE COPY CALL EXEC EXECUTE DO SET RESET GRANT REVOKE INTO OUTFILE DUMPFILE LOAD LOCK UNLOCK FOR SHARE ANALYZE VACUUM ATTACH DETACH PRAGMA SETTINGS FORMAT PROCEDURE HANDLER NEXTVAL SETVAL').split(' '))
const FUNCTIONS = new Set(('COUNT MIN MAX AVG SUM MEDIAN PERCENTILE_CONT PERCENTILE_DISC ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE COALESCE NULLIF GREATEST LEAST ABS ROUND FLOOR CEIL CEILING POWER SQRT MOD CAST CONVERT EXTRACT DATE_TRUNC DATE_PART NOW CURRENT_DATE CURRENT_TIMESTAMP LOWER UPPER LENGTH CHAR_LENGTH TRIM LTRIM RTRIM CONCAT SUBSTRING REPLACE DATE YEAR MONTH DAY IF IFNULL IIF ISNULL STDDEV STDDEV_POP STDDEV_SAMP VARIANCE VAR_POP VAR_SAMP QUANTILE QUANTILEEXACT QUANTILEEXACTINCLUSIVE COUNTIF SUMIF AVGIF MINIF MAXIF TOFLOAT64 TOINT64 TODATE TODATETIME DECIMAL NUMERIC VARCHAR CHAR TIMESTAMP').split(' '))
const GROUPS = new Set(('SELECT FROM WHERE AS IN EXISTS NOT AND OR ON BY HAVING WHEN THEN ELSE DISTINCT ALL VALUES WITH UNION INTERSECT EXCEPT').split(' '))

export function analysisSql(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 32000 || value.includes('\0')) throw new Error('Provide one SELECT query, up to 32,000 characters.')
  const sql = value.trim().replace(/;\s*$/, '')
  const tokens: { word: string; identifier?: boolean; literal?: boolean }[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (/\s/.test(ch)) { i++; continue }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue }
    // Executable comments, optimizer hints, nested comments and dialect-specific
    // escape rules are excluded instead of guessing how a server interprets them.
    if (sql.startsWith('/*', i) || ch === '#' || ch === '\\' || ch === '@' || ch === '$' || ch === ';') throw new Error('SQL comments, variables, escapes and multiple statements are not supported. Use a plain SELECT query.')
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const endQuote = ch === '[' ? ']' : ch
      let text = '', closed = false
      i++
      while (i < sql.length) {
        if (sql[i] === '\\') throw new Error('Use doubled quotes instead of backslash escapes.')
        if (sql[i] === endQuote) {
          if (sql[i + 1] === endQuote) { text += endQuote; i += 2; continue }
          i++; closed = true; break
        }
        text += sql[i++]
      }
      if (!closed) throw new Error('Unterminated SQL string or identifier.')
      tokens.push({ word: text.toUpperCase(), identifier: ch !== "'", literal: ch === "'" })
      continue
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(sql.slice(i))
    if (word) { tokens.push({ word: word[0].toUpperCase() }); i += word[0].length }
    else { tokens.push({ word: ch }); i++ }
  }
  if (!['SELECT', 'WITH'].includes(tokens[0]?.word) || tokens[0]?.identifier) throw new Error('Only SELECT queries and SELECT common table expressions are allowed.')
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n]
    if (!token.identifier && !token.literal && FORBIDDEN.has(token.word)) throw new Error(`Read-only analysis does not allow ${token.word}.`)
    if (tokens[n + 1]?.word !== '(' || token.literal || !/^[A-Z_]/.test(token.word)) continue
    if (token.identifier) throw new Error('Use unquoted built-in function names for analysis.')
    if (['OVER', 'FILTER'].includes(token.word) && tokens[n - 1]?.word === ')') continue
    if (token.word === 'GROUP' && tokens[n - 1]?.word === 'WITHIN') continue
    if (!token.identifier && GROUPS.has(token.word)) continue
    if (!FUNCTIONS.has(token.word)) throw new Error(`Function ${token.word} is not available for read-only analysis. Use standard aggregates, window, date or numeric functions.`)
    if (tokens[n - 1]?.word === '.' && (tokens[n - 2]?.word !== 'PG_CATALOG' || tokens[n - 3]?.word === '.')) throw new Error('Custom or externally qualified functions are not available for analysis.')
  }
  // The derived-table limit applies AFTER the user's aggregation/window query,
  // never to the source rows used to calculate a statistic.
  return `SELECT * FROM (\n${sql}\n) AS hety_analysis_result LIMIT 201`
}
