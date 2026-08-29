import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'

import ErrorBanner from '../ErrorBanner'
import Modal from '../Modal'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { analyseRows, columnLabel, parseDelimited } from '../../lib/csv'

/**
 * Import a CSV: every column shown, every column mapped.
 *
 * This used to hardcode two roles — question and answer — which quietly
 * decided that a CSV could only ever become flashcards. A third column naming
 * each row's question type had nowhere to go, so typed material was flattened
 * into whatever two columns survived. Now the file's actual columns are laid
 * out with a role picker on each: Question, Answer, Question type, Options,
 * Explanation, or Ignore — in any order, because the mapping is the learner's
 * to make, not the header's to dictate.
 *
 * Two destinations. Flashcards behaves exactly as before. Questions assembles
 * the mapped columns into the canonical typed-CSV shape and sends it through
 * the same import pipeline every pasted paper uses — where a row's type
 * (multiple choice, multi-select, short answer, fill-in-the-blank) decides
 * what it becomes, a row without one defaults to multiple choice, and sixty
 * rows in means sixty questions out or a per-row reason why not. No new
 * parsing lives here: this screen only translates columns; the one parser the
 * app already trusts does the reading.
 */

const MAX_ROWS = 1000
const MAX_FILE_MB = 5
const ACCEPT = '.csv,.tsv,.txt,text/csv,text/tab-separated-values'

const ROLES = [
  { id: 'question', label: 'Question' },
  { id: 'answer', label: 'Answer' },
  { id: 'type', label: 'Question type' },
  { id: 'options', label: 'Options' },
  { id: 'explanation', label: 'Explanation' },
  { id: 'ignore', label: 'Ignore' },
]

// Header spellings that pre-select a role, so a well-named CSV maps itself
// and the picker is confirmation rather than homework.
const HEADER_ROLE = [
  [/^(question|prompt|q|front|term)$/i, 'question'],
  [/^(answer|answers|correct( answer)?|key|back|definition)$/i, 'answer'],
  [/^(type|kind|question ?type)$/i, 'type'],
  [/^(options|choices)$/i, 'options'],
  [/^(explanation|why|rationale)$/i, 'explanation'],
]

function autoMap(headers, columnCount, fallbackQ, fallbackA) {
  const roles = Array.from({ length: columnCount }, () => 'ignore')
  const taken = new Set()
  if (headers) {
    headers.forEach((h, i) => {
      for (const [re, role] of HEADER_ROLE) {
        if (re.test((h || '').trim()) && !taken.has(role)) {
          roles[i] = role
          taken.add(role)
          break
        }
      }
    })
  }
  // Nothing recognisable: fall back to the old two-column detection.
  if (!taken.has('question') && fallbackQ < columnCount) roles[fallbackQ] = 'question'
  if (!taken.has('answer') && fallbackA < columnCount && roles[fallbackA] === 'ignore') {
    roles[fallbackA] = 'answer'
  }
  return roles
}

/** One cell, made safe for the canonical CSV this modal assembles. */
function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export default function CsvFlashcardImportModal({ open, moduleId, onClose }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const inputRef = useRef(null)

  const [parsed, setParsed] = useState(null)
  const [roles, setRoles] = useState([])
  const [dest, setDest] = useState('flashcards')
  const [name, setName] = useState('')
  const [error, setError] = useState(null)

  const reset = () => {
    setParsed(null)
    setRoles([])
    setDest('flashcards')
    setName('')
    setError(null)
  }
  const close = () => {
    reset()
    onClose()
  }

  const importCards = useMutation({
    mutationFn: (body) => api.importFlashcards(moduleId, body),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      toast.success(
        `Imported ${res.count} card${res.count === 1 ? '' : 's'} into “${res.domain_title}”.`,
      )
      close()
    },
    onError: (e) => setError(e?.message || 'Could not import the deck.'),
  })

  const importQuestions = useMutation({
    mutationFn: (text) =>
      api.importPaste(moduleId, [
        { text, content_type: 'practice_exam', title: name.trim() || 'Imported questions' },
      ]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources', moduleId] })
      toast.success(
        'Import queued — each row becomes the question type it names, and '
        + 'the paper appears with your practice exams when it lands.',
      )
      close()
    },
    onError: (e) => setError(e?.message || 'Could not import the questions.'),
  })

  async function onFile(file) {
    setError(null)
    if (!file) return
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`That file is too large — the limit is ${MAX_FILE_MB} MB.`)
      return
    }
    let text
    try {
      text = await file.text()
    } catch {
      setError('Could not read that file.')
      return
    }
    const { rows } = parseDelimited(text)
    if (!rows.length) {
      setError('That file appears to be empty.')
      return
    }
    const info = analyseRows(rows)
    if (info.columnCount < 2) {
      setError('The file needs at least two columns — a question and an answer.')
      return
    }
    const dataRows = info.hasHeader ? rows.slice(1) : rows
    if (!dataRows.length) {
      setError('No rows were found beneath the header.')
      return
    }
    const mapped = autoMap(
      info.headers, info.columnCount, info.questionIndex, info.answerIndex,
    )
    setParsed({ dataRows, headers: info.headers, columnCount: info.columnCount })
    setRoles(mapped)
    // A mapped type column is the tell that this is typed material, not a deck.
    setDest(mapped.includes('type') ? 'questions' : 'flashcards')
    setName(file.name.replace(/\.[^.]+$/, '').slice(0, 200))
  }

  function setRole(column, role) {
    setRoles((current) => {
      const next = [...current]
      // A role belongs to one column: assigning it elsewhere frees the old one,
      // so the learner never has to hunt for a hidden duplicate. Ignore is the
      // one role any number of columns can share.
      if (role !== 'ignore') {
        for (let i = 0; i < next.length; i += 1) {
          if (next[i] === role) next[i] = 'ignore'
        }
      }
      next[column] = role
      return next
    })
  }

  const idxOf = (role) => roles.indexOf(role)
  const qIdx = idxOf('question')
  const aIdx = idxOf('answer')
  const tIdx = idxOf('type')
  const oIdx = idxOf('options')
  const eIdx = idxOf('explanation')

  function doImport() {
    if (!parsed || qIdx < 0 || aIdx < 0) return
    const rows = parsed.dataRows.slice(0, MAX_ROWS)

    if (dest === 'flashcards') {
      const cards = rows
        .map((r) => ({ front: (r[qIdx] || '').trim(), back: (r[aIdx] || '').trim() }))
        .filter((c) => c.front && c.back)
      if (!cards.length) {
        setError('None of the rows have both a question and an answer in the mapped columns.')
        return
      }
      importCards.mutate({ name: name.trim() || undefined, cards })
      return
    }

    // Questions: reassemble the mapped columns into the canonical typed CSV
    // and let the one parser the app already trusts do the reading. A row
    // with no type becomes multiple choice by that parser's own default.
    const header = 'type,question,options,answer,explanation'
    const lines = rows
      .filter((r) => (r[qIdx] || '').trim() && (r[aIdx] || '').trim())
      .map((r) => [
        tIdx >= 0 ? (r[tIdx] || '').trim() || 'mcq' : 'mcq',
        (r[qIdx] || '').trim(),
        oIdx >= 0 ? (r[oIdx] || '').trim() : '',
        (r[aIdx] || '').trim(),
        eIdx >= 0 ? (r[eIdx] || '').trim() : '',
      ].map(csvCell).join(','))
    if (!lines.length) {
      setError('None of the rows have both a question and an answer in the mapped columns.')
      return
    }
    importQuestions.mutate([header, ...lines].join('\n'))
  }

  const total = parsed?.dataRows.length || 0
  const overLimit = total > MAX_ROWS
  const unmapped = parsed && (qIdx < 0 || aIdx < 0)
  const busy = importCards.isPending || importQuestions.isPending
  const preview = parsed ? parsed.dataRows.slice(0, 4) : []

  return (
    <Modal open={open} title="Import a CSV" onClose={busy ? undefined : close}>
      <div className="space-y-4">
        {!parsed ? (
          <button
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-2xl border
                       border-dashed border-border px-4 py-8 text-center
                       transition-colors hover:border-accent/50"
          >
            <FileSpreadsheet size={22} className="text-accent2" aria-hidden="true" />
            <span className="text-sm font-medium text-pri">Choose a CSV file</span>
            <span className="text-xs text-sec">
              Flashcards, or typed questions — you&rsquo;ll map the columns next
            </span>
          </button>
        ) : (
          <>
            {/* Destination first: it decides which roles matter. */}
            <div
              role="group"
              aria-label="Import as"
              className="flex items-center gap-1 rounded-full bg-surface2 p-1"
            >
              {[['flashcards', 'Flashcards'], ['questions', 'Questions']].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setDest(id)}
                  aria-pressed={dest === id}
                  className={[
                    'min-h-9 flex-1 rounded-full px-3 text-xs font-medium transition-colors',
                    dest === id ? 'bg-accent text-white' : 'text-sec hover:text-pri',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Every column the file actually has, each with a role. */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-sec">
                Your columns — map each one
              </p>
              {Array.from({ length: parsed.columnCount }, (_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-pri">
                      {columnLabel(parsed.headers, i)}
                    </span>
                    <span className="block truncate text-[11px] text-sec">
                      {(preview[0]?.[i] || '').slice(0, 48) || '—'}
                    </span>
                  </span>
                  <select
                    value={roles[i] || 'ignore'}
                    onChange={(e) => setRole(i, e.target.value)}
                    aria-label={`Role for ${columnLabel(parsed.headers, i)}`}
                    className="input min-h-9 w-36 shrink-0 py-1 text-xs"
                  >
                    {ROLES.filter(
                      (r) => dest === 'questions'
                        || ['question', 'answer', 'ignore'].includes(r.id),
                    ).map((r) => (
                      <option key={r.id} value={r.id}>{r.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {dest === 'questions' && (
              <p className="rounded-xl bg-surface2 px-3 py-2 text-[11px] leading-relaxed text-sec">
                A row&rsquo;s type can be multiple choice, multi-select, short
                answer or fill-in-the-blank. Rows without one import as
                multiple choice. Choice types read their options from the
                Options column (pipe-separated) and their answer as letters;
                text types read the answer as the accepted answer itself.
              </p>
            )}

            {/* The first rows, as they'll import. */}
            <div className="space-y-1 rounded-xl bg-surface2 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-sec">
                Preview
              </p>
              {preview.map((r, i) => (
                <p key={i} className="truncate text-xs text-pri">
                  {(r[qIdx] || '—').slice(0, 44)}
                  <span className="text-sec"> → {(r[aIdx] || '—').slice(0, 24)}</span>
                  {dest === 'questions' && tIdx >= 0 && (
                    <span className="ml-1.5 rounded bg-accent/10 px-1 py-0.5 text-[10px] text-accent2">
                      {(r[tIdx] || 'mcq').trim() || 'mcq'}
                    </span>
                  )}
                </p>
              ))}
            </div>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-sec">
                {dest === 'flashcards' ? 'Deck name' : 'Paper name'}
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input w-full"
              />
            </label>

            {unmapped && (
              <ErrorBanner message="Map one column as the question and one as the answer." />
            )}
            {overLimit && (
              <p className="text-xs text-warning">
                {total.toLocaleString()} rows — only the first {MAX_ROWS.toLocaleString()} import.
              </p>
            )}
          </>
        )}

        <ErrorBanner message={error} onDismiss={() => setError(null)} />

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />

        <div className="flex gap-2">
          <button onClick={close} disabled={busy} className="btn-secondary flex-1">
            Cancel
          </button>
          {parsed && (
            <button
              onClick={doImport}
              disabled={busy || unmapped}
              className="btn-primary flex-1 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                `Import ${Math.min(total, MAX_ROWS).toLocaleString()} row${total === 1 ? '' : 's'}`
              )}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
