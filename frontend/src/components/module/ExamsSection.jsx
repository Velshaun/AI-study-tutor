import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, ClipboardList, Loader2, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import SwipeToDelete from '../study/SwipeToDelete'
import { useConfirm } from '../../hooks/useConfirm'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { path } from '../../routes'

/**
 * Practice exams, and every sitting of one.
 *
 * These sit outside the domain list because they are the one thing that isn't
 * scoped to a domain: a paper spans the whole blueprint, weighted the way the
 * real exam weights it, and filing it under any single topic would be a lie
 * about what it tests.
 *
 * Generating a full exam had no entry point at all before this — the screen
 * that did it was reachable only by typing its URL — so an imported past paper
 * could be sat but a generated one could not be made.
 */
export default function ExamsSection({ moduleId, exams = [], questionCount, onDeleted }) {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const queryClient = useQueryClient()

  const { data: attempts } = useQuery({
    queryKey: ['exam-attempts', moduleId],
    queryFn: ({ signal }) => api.examAttempts(moduleId, signal),
  })
  const history = Array.isArray(attempts) ? attempts : []

  const build = useMutation({
    mutationFn: () => api.generateExam({ module_id: moduleId }),
    onSuccess: (exam) => {
      queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
      if (exam?.id) navigate(path('examRun', { examId: exam.id }))
    },
    onError: (e) => toast.error(e?.message || 'Could not build a practice exam.'),
  })

  async function remove(exam) {
    const ok = await confirm({
      title: 'Delete this exam?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteExam(exam.id)
      toast.success('Exam deleted')
    } catch (e) {
      toast.error(e?.message || 'Could not delete that exam.')
    } finally {
      onDeleted?.()
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 border-l-2 border-accent pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
        <ClipboardList size={13} aria-hidden="true" />
        Practice exams
      </h2>
      <p className="px-1 text-xs text-sec">
        The whole blueprint at once, weighted the way the real paper is.
      </p>

      <button
        onClick={() => build.mutate()}
        disabled={build.isPending}
        className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border
                   px-4 py-3.5 text-left transition-colors hover:border-accent/50
                   disabled:opacity-60"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
          {build.isPending ? (
            <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          ) : (
            <Plus size={18} aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-pri">
            {build.isPending ? 'Building your paper…' : 'New practice exam'}
          </span>
          <span className="block text-xs text-sec">
            {questionCount} questions, weighted towards what you find hardest
          </span>
        </span>
      </button>

      {exams.length > 0 && (
        <div className="space-y-2">
          {exams.map((e) => (
            <SwipeToDelete key={e.id} label="exam" onDelete={() => remove(e)}>
              <button
                onClick={() => navigate(path('examRun', { examId: e.id }))}
                className="card-interactive flex w-full items-center gap-3 text-left"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
                  <ClipboardList size={18} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-pri">
                    {e.title}
                  </span>
                  <span className="block truncate text-xs text-sec">
                    {e.question_count} questions
                    {e.duration_minutes ? ` · ${e.duration_minutes} min` : ''}
                  </span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-sec" aria-hidden="true" />
              </button>
            </SwipeToDelete>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="card space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-sec">
            Your sittings
          </p>
          <div className="space-y-1.5">
            {history.map((a) => (
              <div key={a.id} className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 flex-1 truncate text-sm text-pri">
                  {a.kind === 'pre_assessment' ? 'Baseline' : 'Practice exam'}
                  <span className="text-sec">
                    {' '}· {a.correct} of {a.total}
                  </span>
                </p>
                <p
                  className={`shrink-0 text-sm font-semibold tabular-nums ${
                    a.passed === true
                      ? 'text-success'
                      : a.passed === false
                        ? 'text-warning'
                        : 'text-pri'
                  }`}
                >
                  {Math.round(a.score)}%
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
