import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'

import ErrorBanner from '../ErrorBanner'
import Modal from '../Modal'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { analyseRows, columnLabel, parseDelimited } from '../../lib/csv'

/**
 * Import a flashcard deck from a CSV / Quizlet export.
 *
 * The file is parsed in the browser so the learner can verify the column
 * mapping and preview the first rows before anything is written. On confirm the
 * parsed question/answer rows are posted to `/flashcards/import`, which stores
 * them as a deck (its own domain) that then appears in the Classroom tab like
 * any generated set. No source-ingestion pipeline is involved.
 */

const MAX_ROWS = 1000
const MAX_FILE_MB = 5
const ACCEPT = '.csv,.tsv,.txt,text/csv,text/tab-separated-values'

export default function CsvFlashcardImportModal({ open, moduleId, onClose }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const inputRef = useRef(null)

  // parsed: { dataRows: string[][], headers: string[]|null, columnCount }
  const [parsed, setParsed] = useState(null)
  const [name, setName] = useState('')
  const [qIdx, setQIdx] = useState(0)
  const [aIdx, setAIdx] = useState(1)
  const [autoDetected, setAutoDetected] = useState(false)
  const [error, setError] = useState(null)

  const reset = () => {
    setParsed(null)
    setName('')
    setQIdx(0)
    setAIdx(1)
    setAutoDetected(false)
    setError(null)
  }
  const close = () => {
    reset()
    onClose()
  }

  const importMut = useMutation({
    mutationFn: (body) => api.importFlashcards(moduleId, body),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module-stats', moduleId] })
      toast.success(
        `Imported ${res.count} card${res.count === 1 ? '' : 's'} into “${res.domain_title}”.`,
      )
      close()
    },
    onError: (e) => setError(e?.message || 'Could not import the deck.'),
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
      setError('A flashcard CSV needs at least two columns — a question and an answer.')
      return
    }
    const dataRows = info.hasHeader ? rows.slice(1) : rows
    if (!dataRows.length) {
      setError('No rows were found beneath the header.')
      return
    }
    setParsed({ dataRows, headers: info.headers, columnCount: info.columnCount })
    setQIdx(info.questionIndex)
    setAIdx(info.answerIndex)
    setAutoDetected(info.autoDetected)
    setName(file.name.replace(/\.[^.]+$/, '').slice(0, 200))
  }

  function doImport() {
    if (!parsed || qIdx === aIdx) return
    const cards = parsed.dataRows
      .slice(0, MAX_ROWS)
      .map((r) => ({ front: (r[qIdx] || '').trim(), back: (r[aIdx] || '').trim() }))
      .filter((c) => c.front && c.back)
    if (!cards.length) {
      setError('None of the rows have both a question and an answer in the chosen columns.')
      return
    }
    importMut.mutate({ name: name.trim() || undefined, cards })
  }

  const total = parsed?.dataRows.length || 0
  const overLimit = total > MAX_ROWS
  const sameColumn = qIdx === aIdx
  const cols = parsed ? Array.from({ length: parsed.columnCount }, (_, i) => i) : []
  const preview = parsed
    ? parsed.dataRows.slice(0, 5).map((r) => ({ q: r[qIdx] || '', a: r[aIdx] || '' }))
    : []

  return (
    <Modal open={open} title="Import flashcards from CSV" onClose={close}>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {!parsed ? (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-xl border-2
                       border-dashed border-border px-4 py-8 text-center transition-colors
                       hover:border-accent/50"
          >
            <FileSpreadsheet size={22} className="text-sec" aria-hidden="true" />
            <span className="text-sm font-medium text-pri">Choose a CSV file</span>
            <span className="text-xs text-sec">
              A Quizlet export or a two-column “question, answer” CSV
            </span>
          </button>
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      ) : (
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-0.5">
          {/* Deck name */}
          <div className="space-y-1.5">
            <label htmlFor="deck-name" className="text-xs font-medium uppercase tracking-wider text-sec">
              Deck name
            </label>
            <input
              id="deck-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              placeholder="Imported flashcards"
              className="input"
            />
          </div>

          {/* Column mapping */}
          {!autoDetected && (
            <p className="text-xs text-sec">
              Couldn’t detect the columns automatically — confirm which holds the
              question and which holds the answer.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <ColumnSelect
              label="Question column"
              value={qIdx}
              cols={cols}
              headers={parsed.headers}
              onChange={setQIdx}
            />
            <ColumnSelect
              label="Answer column"
              value={aIdx}
              cols={cols}
              headers={parsed.headers}
              onChange={setAIdx}
            />
          </div>

          <p className="text-xs text-sec">
            {total.toLocaleString()} row{total === 1 ? '' : 's'} detected.
          </p>
          {sameColumn && (
            <ErrorBanner message="The question and answer are set to the same column — pick different columns." />
          )}
          {overLimit && (
            <ErrorBanner
              message={`This file has ${total.toLocaleString()} rows, over the ${MAX_ROWS.toLocaleString()} limit. Only the first ${MAX_ROWS.toLocaleString()} will be imported.`}
            />
          )}

          {/* Preview */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-sec">
              Preview (first {preview.length} row{preview.length === 1 ? '' : 's'})
            </p>
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="grid grid-cols-2 gap-px bg-border text-xs">
                <Cell className="bg-surface2 font-semibold text-sec">Question</Cell>
                <Cell className="bg-surface2 font-semibold text-sec">Answer</Cell>
                {preview.map((p, i) => (
                  <PreviewRow key={i} q={p.q} a={p.a} />
                ))}
              </div>
            </div>
          </div>

          <ErrorBanner message={error} onDismiss={() => setError(null)} />

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={reset} className="btn-secondary flex-1">
              Choose another
            </button>
            <button
              type="button"
              onClick={doImport}
              disabled={importMut.isPending || sameColumn}
              className="btn-primary flex-1"
            >
              {importMut.isPending && (
                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              )}
              Import {Math.min(total, MAX_ROWS).toLocaleString()} card
              {Math.min(total, MAX_ROWS) === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function ColumnSelect({ label, value, cols, headers, onChange }) {
  return (
    <label className="space-y-1.5 text-xs font-medium uppercase tracking-wider text-sec">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="input font-normal normal-case"
      >
        {cols.map((i) => (
          <option key={i} value={i}>
            {columnLabel(headers, i)}
          </option>
        ))}
      </select>
    </label>
  )
}

function PreviewRow({ q, a }) {
  return (
    <>
      <Cell className="bg-surface text-pri">{q || <span className="text-sec">—</span>}</Cell>
      <Cell className="bg-surface text-sec">{a || <span className="text-sec">—</span>}</Cell>
    </>
  )
}

function Cell({ className = '', children }) {
  return (
    <div className={`min-w-0 truncate px-2.5 py-2 ${className}`} title={typeof children === 'string' ? children : undefined}>
      {children}
    </div>
  )
}
