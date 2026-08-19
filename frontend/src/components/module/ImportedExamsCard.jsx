import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  FileUp,
  Loader2,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'
import { useRef, useState } from 'react'

import Modal from '../Modal'
import { useConfirm } from '../../hooks/useConfirm'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import ErrorBanner from '../ErrorBanner'

/**
 * Imported practice exams — spec Prompt 10c (items 5 & 6).
 *
 * Lists imported question sets as cards (source name, question count,
 * favourite/delete), offers an "Import practice exam" PDF modal, and a "Take
 * practice exam" action that jumps to the weighted-generation flow.
 */
export default function ImportedExamsCard({ moduleId }) {
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const toast = useToast()
  const [showImport, setShowImport] = useState(false)

  const { data } = useQuery({
    queryKey: ['imported', moduleId],
    queryFn: ({ signal }) => api.importedSets(moduleId, signal),
  })
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['imported', moduleId] })

  const favourite = useMutation({
    mutationFn: (batchId) => api.favouriteImported(batchId),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (batchId) => api.deleteImported(batchId),
    onSuccess: () => {
      invalidate()
      toast.success('Imported set deleted')
    },
    onError: (e) => toast.error(e?.message || 'Could not delete set'),
  })

  async function confirmDelete(set) {
    const ok = await confirm({
      title: 'Delete imported set?',
      message: `"${set.source_name}" and its ${set.question_count} questions will be removed.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) remove.mutate(set.batch_id)
  }

  const sets = Array.isArray(data) ? data : []

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-pri">Import practice exam</h2>
          <p className="text-xs text-sec">
            A past paper you already have. Generating one is in Generate above.
          </p>
        </div>
        <button onClick={() => setShowImport(true)} className="btn-secondary shrink-0">
          <FileUp size={15} aria-hidden="true" />
          Import
        </button>
      </div>

      {/* Imported sets */}
      {sets.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-sec">
            Imported sets
          </p>
          {sets.map((s) => (
            <div
              key={s.batch_id}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface2/50 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-pri">{s.source_name}</p>
                <p className="text-xs text-sec">{s.question_count} questions</p>
              </div>
              <button
                onClick={() => favourite.mutate(s.batch_id)}
                aria-label={s.is_favourite ? 'Unfavourite' : 'Favourite'}
                className="btn-ghost size-11 shrink-0 rounded-full p-0"
              >
                <Star
                  size={16}
                  className={s.is_favourite ? 'fill-warning text-warning' : ''}
                  aria-hidden="true"
                />
              </button>
              <button
                onClick={() => confirmDelete(s)}
                aria-label="Delete set"
                className="btn-ghost size-11 shrink-0 rounded-full p-0 hover:text-warning"
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <ImportModal
        open={showImport}
        moduleId={moduleId}
        onClose={() => setShowImport(false)}
        onDone={(imported) => {
          invalidate()
          const exams = imported.exams?.length || 0
          toast.success(
            exams > 1
              ? `Imported ${exams} exams · ${imported.question_count} questions`
              : `Imported ${imported.question_count} questions`,
          )
        }}
      />
    </div>
  )
}

function ImportModal({ open, moduleId, onClose, onDone }) {
  const fileInput = useRef(null)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const importExam = useMutation({
    mutationFn: (file) => api.importExam(moduleId, file),
    onSuccess: (set) => {
      setResult(set)
      setError(null)
      onDone(set)
    },
    onError: (e) => setError(e?.message || 'Could not import that PDF.'),
  })

  function close() {
    setResult(null)
    setError(null)
    onClose()
  }

  return (
    <Modal open={open} title="Import practice exam" onClose={close}>
      {result ? (
        <div className="space-y-4 text-center">
          <div className="space-y-2 text-sm text-pri">
            <p>
              Imported <span className="font-semibold">{result.question_count}</span>{' '}
              question{result.question_count === 1 ? '' : 's'} from{' '}
              {result.source_name}.
            </p>
            {/* A file holding several papers becomes several exams, each sat
                on its own — so say which ones arrived. */}
            {result.exams?.length > 1 && (
              <ul className="space-y-1 text-left text-xs text-sec">
                {result.exams.map((e) => (
                  <li key={e.id}>
                    {e.title} · {e.question_count} questions
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-sec">
              {result.exams?.length === 1 ? 'It is' : 'They are'} in Practice
              Exams under Generated media.
            </p>
          </div>
          <button onClick={close} className="btn-primary w-full">
            Done
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-sec">
            Upload a practice-exam PDF. The questions come across exactly as
            written, and a file holding several papers becomes several exams.
          </p>
          <button
            onClick={() => fileInput.current?.click()}
            disabled={importExam.isPending}
            className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed
                       border-border px-4 py-8 text-center transition-colors hover:border-accent/50"
          >
            {importExam.isPending ? (
              <>
                <Loader2 size={22} className="animate-spin text-accent" aria-hidden="true" />
                <span className="text-sm text-pri">Reading the exam…</span>
              </>
            ) : (
              <>
                <Upload size={22} className="text-sec" aria-hidden="true" />
                <span className="text-sm text-pri">Choose a PDF</span>
              </>
            )}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".pdf"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) importExam.mutate(f)
            }}
            className="hidden"
          />
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      )}
    </Modal>
  )
}
