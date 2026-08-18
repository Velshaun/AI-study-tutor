/**
 * A small, dependency-free delimited-text parser for flashcard imports.
 *
 * Handles the two formats the import flow promises: a generic two-column CSV and
 * a Quizlet export (which is typically tab- or comma-separated, sometimes with
 * quoted, multi-line definitions). It auto-detects the delimiter, honours
 * RFC-4180 quoting (`""` escapes a quote; quoted fields may contain the
 * delimiter and newlines), and strips a UTF-8 BOM.
 */

// Header cells that identify the question / answer columns, so a labelled export
// (Quizlet, Anki, generic) maps without the user having to intervene.
const QUESTION_HEADERS = [
  'question', 'q', 'term', 'front', 'prompt', 'word', 'key', 'concept',
]
const ANSWER_HEADERS = [
  'answer', 'a', 'definition', 'back', 'meaning', 'value', 'translation', 'desc',
]

/** Pick the delimiter that appears most on the first non-empty line. */
function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim().length) || ''
  let best = ','
  let bestCount = -1
  for (const d of [',', '\t', ';', '|']) {
    const count = line.split(d).length - 1
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best
}

/** Parse the text into rows of string fields. */
function parseRows(text, delimiter) {
  const rows = []
  let field = ''
  let row = []
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1 // consume the escaped quote
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  // Trailing field / row (no final newline).
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  // Drop rows that are entirely empty.
  return rows.filter((r) => r.some((c) => c.trim().length))
}

/**
 * Parse delimited text into `{ rows, delimiter }`.
 * `rows` is an array of string arrays; empty lines are dropped.
 */
export function parseDelimited(text) {
  const clean = (text || '').replace(/^\uFEFF/, '')
  if (!clean.trim()) return { rows: [], delimiter: ',' }
  const delimiter = detectDelimiter(clean)
  return { rows: parseRows(clean, delimiter), delimiter }
}

/**
 * Given the parsed rows, work out the header (if any) and which columns hold the
 * question and answer.
 *
 * Returns `{ hasHeader, headers, columnCount, questionIndex, answerIndex,
 * autoDetected }`. `autoDetected` is true only when a labelled header mapped
 * both columns — otherwise the caller should let the user confirm the mapping.
 */
export function analyseRows(rows) {
  const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const first = rows[0] || []
  const norm = first.map((c) => c.trim().toLowerCase())

  const qFromHeader = norm.findIndex((c) => QUESTION_HEADERS.includes(c))
  const aFromHeader = norm.findIndex((c) => ANSWER_HEADERS.includes(c))
  const hasHeader = qFromHeader !== -1 || aFromHeader !== -1
  const autoDetected =
    qFromHeader !== -1 && aFromHeader !== -1 && qFromHeader !== aFromHeader

  const questionIndex = qFromHeader !== -1 ? qFromHeader : 0
  let answerIndex
  if (aFromHeader !== -1 && aFromHeader !== questionIndex) {
    answerIndex = aFromHeader
  } else {
    answerIndex = questionIndex === 0 && columnCount > 1 ? 1 : Math.max(0, columnCount - 1)
  }

  return {
    hasHeader,
    headers: hasHeader ? first : null,
    columnCount,
    questionIndex,
    answerIndex,
    autoDetected,
  }
}

/** Human label for a column in the mapping selectors. */
export function columnLabel(headers, index) {
  const name = headers?.[index]?.trim()
  return name ? `${name} (column ${index + 1})` : `Column ${index + 1}`
}
