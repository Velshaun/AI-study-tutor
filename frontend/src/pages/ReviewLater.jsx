import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader2, PartyPopper } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import PracticeRunner from '../components/study/PracticeRunner'
import { useToast } from '../hooks/useToast'
import { ApiError, api } from '../lib/api'

/**
 * Review Later queue — spec 6.4.
 *
 * Re-runs the questions the learner flagged, in 'review' mode:
 *  - Answer WRONG → the question stays in the queue automatically; the runner
 *    just moves on.
 *  - Answer RIGHT → the learner chooses Keep Reviewing (stays) or Got It
 *    (removed from the queue).
 *
 * A finished pass refetches the queue and, if anything is still flagged (kept,
 * or answered wrong), starts another round — so the queue drains only as the
 * learner genuinely masters it. Empty queue shows the "you're solid" state.
 */
export default function ReviewLater() {
  const { domainId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [round, setRound] = useState(0)

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['review-later', domainId],
    queryFn: ({ signal }) => api.reviewLaterQuestions(domainId, signal),
  })

  const gotIt = useMutation({
    mutationFn: (qid) => api.gotItQuestion(qid),
    onError: (e) => toast.error(e?.message || 'Could not update the queue'),
  })

  const questions = Array.isArray(data) ? data : []
  const isAuth = error instanceof ApiError && error.isAuth

  async function handleComplete() {
    await refetch()
    queryClient.invalidateQueries({ queryKey: ['practice-questions', domainId] })
    setRound((r) => r + 1) // remount the runner onto the refreshed queue
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="btn-ghost -ml-2 size-11 rounded-full p-0">
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <h1 className="text-xl font-semibold text-pri">Review later</h1>
      </header>

      {isPending ? (
        <div className="card flex justify-center py-14" role="status" aria-label="Loading">
          <Loader2 size={24} className="animate-spin text-accent" aria-hidden="true" />
        </div>
      ) : isAuth ? (
        <p className="card text-center text-sm text-sec">Sign in to see your queue.</p>
      ) : error ? (
        <p className="card text-center text-sm text-sec">{error.message}</p>
      ) : questions.length === 0 ? (
        <SolidState />
      ) : (
        <PracticeRunner
          key={round}
          questions={questions}
          mode="review"
          onSubmit={(q, chosen) => api.submitAnswer(q.id, chosen)}
          onFlag={() => {}} /* Keep Reviewing — already flagged, just move on */
          onGotIt={(qid) => gotIt.mutate(qid)}
          onComplete={handleComplete}
        />
      )}
    </div>
  )
}

function SolidState() {
  return (
    <div className="card flex flex-col items-center gap-5 py-16 text-center">
      <div className="flex size-20 items-center justify-center rounded-full bg-success/15">
        <PartyPopper size={34} className="text-success" aria-hidden="true" />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold text-pri">You&rsquo;re solid on this domain!</h2>
        <p className="mx-auto max-w-xs text-sm text-sec">
          Nothing left in your review queue. Flag questions during practice to
          revisit them here.
        </p>
      </div>
    </div>
  )
}
