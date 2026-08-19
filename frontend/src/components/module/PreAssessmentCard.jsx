import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { path } from '../../routes'

/**
 * Sit the baseline before studying.
 *
 * A learner opening a fresh module has no idea which domains they already know,
 * and neither does the app. Everything downstream — which domains get the most
 * questions, whether the score in a fortnight means improvement or noise — is
 * measured from a starting point, and without this there isn't one.
 *
 * It is a full weighted paper, not a shortened diagnostic: a baseline that
 * doesn't match the real exam's shape can't be compared with the attempts that
 * follow, which are all full papers. And it is deliberately not adaptive —
 * weighting a first sitting towards weaknesses the app has not yet observed
 * would be measuring nothing, twice.
 */
export default function PreAssessmentCard({ moduleId, questionCount }) {
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()

  const start = useMutation({
    mutationFn: () => api.generatePreAssessment(moduleId),
    onSuccess: (exam) => {
      queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
      if (exam?.id) navigate(path('examRun', { examId: exam.id }))
    },
    onError: (e) =>
      toast.error(e?.message || 'Could not build your baseline assessment.'),
  })

  return (
    <div className="card space-y-3 border border-accent/30">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
          <ClipboardCheck size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold text-pri">Start with a baseline</p>
          <p className="text-xs leading-relaxed text-sec">
            A full {questionCount}-question paper, weighted the way the real exam
            is. You aren&rsquo;t expected to do well — it&rsquo;s how the app
            works out which domains to put in front of you first, and what your
            progress is being measured against.
          </p>
        </div>
      </div>
      <button
        onClick={() => start.mutate()}
        disabled={start.isPending}
        className="btn-primary w-full"
      >
        {start.isPending ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            Building your paper…
          </>
        ) : (
          <>
            <ClipboardCheck size={16} aria-hidden="true" />
            Take the pre-assessment
          </>
        )}
      </button>
    </div>
  )
}
