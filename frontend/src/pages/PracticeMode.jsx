import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GraduationCap, Loader2, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import PageTitle from '../components/PageTitle'
import PracticeRunner from '../components/study/PracticeRunner'
import { useToast } from '../hooks/useToast'
import { ApiError, api } from '../lib/api'
import { path } from '../routes'

/**
 * Practice Exam Mode — spec 6.4.
 *
 * Domain-scoped, get-or-generate: the first visit builds a question set (slow —
 * an AI call, so it gets a proper working state), later visits reuse the cached
 * set. The run itself lives in PracticeRunner; this page owns loading, the
 * flag/got-it mutations, and the completion screen.
 */
export default function PracticeMode() {
  const { domainId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()

  const [done, setDone] = useState(false)
  const [flagged, setFlagged] = useState(0)

  const { data, isPending, error } = useQuery({
    queryKey: ['practice-questions', domainId],
    queryFn: ({ signal }) => api.practiceQuestions(domainId, {}, signal),
    retry: false,
  })

  const flag = useMutation({
    mutationFn: (qid) => api.flagQuestion(qid),
    onError: (e) => toast.error(e?.message || 'Could not flag that question'),
  })
  const gotIt = useMutation({
    mutationFn: (qid) => api.gotItQuestion(qid),
  })

  const questions = Array.isArray(data) ? data : []
  const isAuth = error instanceof ApiError && error.isAuth

  function handleFlag(qid) {
    setFlagged((n) => n + 1)
    flag.mutate(qid)
    toast.success('Flagged for review')
  }
  function handleGotIt(qid) {
    gotIt.mutate(qid)
  }
  function complete() {
    // Review Later may have changed — let its screen refetch.
    queryClient.invalidateQueries({ queryKey: ['review-later', domainId] })
    setDone(true)
  }

  return (
    <div className="space-y-6">
      <PageTitle onBack={() => navigate(-1)} subtitle="Immediate feedback, one question at a time.">
        Practice
      </PageTitle>

      {isPending ? (
        <GeneratingState />
      ) : isAuth ? (
        <p className="card text-center text-sm text-sec">Sign in to practise.</p>
      ) : error ? (
        <div className="card space-y-4 py-10 text-center">
          <p className="text-sm text-sec">
            {error?.message || 'Could not build a practice set for this domain.'}
          </p>
          <button
            onClick={() =>
              queryClient.invalidateQueries({ queryKey: ['practice-questions', domainId] })
            }
            className="btn-secondary mx-auto"
          >
            <RotateCcw size={16} aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : questions.length === 0 ? (
        <p className="card text-center text-sm text-sec">
          No practice questions yet. Generate a lecture for this domain first, then
          come back.
        </p>
      ) : done ? (
        <CompleteScreen
          total={questions.length}
          flagged={flagged}
          onReview={() => navigate(path('reviewLater', { domainId }))}
          onAgain={() => {
            setDone(false)
            setFlagged(0)
          }}
        />
      ) : (
        <PracticeRunner
          questions={questions}
          mode="practice"
          onSubmit={(q, chosen) => api.submitAnswer(q.id, chosen)}
          onFlag={handleFlag}
          onGotIt={handleGotIt}
          onComplete={complete}
        />
      )}
    </div>
  )
}

function GeneratingState() {
  return (
    <div className="card flex flex-col items-center gap-4 py-14 text-center">
      <Loader2 size={26} className="animate-spin text-accent" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-pri">Building your practice set…</p>
        <p className="text-xs text-sec">
          Writing questions with per-option explanations. This takes a moment.
        </p>
      </div>
    </div>
  )
}

function CompleteScreen({ total, flagged, onReview, onAgain }) {
  return (
    <div className="card flex flex-col items-center gap-5 py-12 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-success">
        <GraduationCap size={30} className="text-white" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-pri">Practice complete</h2>
        <p className="text-sm text-sec">
          {total} question{total === 1 ? '' : 's'} reviewed
          {flagged > 0
            ? ` · ${flagged} flagged for later`
            : ' · nothing flagged, nice work'}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {flagged > 0 && (
          <button onClick={onReview} className="btn-primary min-h-11">
            Review flagged questions
          </button>
        )}
        <button onClick={onAgain} className="btn-secondary min-h-11">
          <RotateCcw size={16} aria-hidden="true" />
          Practise again
        </button>
      </div>
    </div>
  )
}
