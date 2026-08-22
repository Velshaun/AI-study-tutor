import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GraduationCap, Loader2, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import PageTitle from '../components/PageTitle'
import PracticeRunner from '../components/study/PracticeRunner'
import { useAttempt } from '../hooks/useAttempt'
import { useToast } from '../hooks/useToast'
import { ApiError, api } from '../lib/api'
import { path } from '../routes'
import { summarise } from '../lib/session'
import { useSessionFinish } from '../hooks/useSessionFinish'

/**
 * Practice Exam Mode — spec 6.4.
 *
 * Domain-scoped, get-or-generate. The first visit builds the set, but only its
 * opening questions block the response: the server keeps writing the rest while
 * the learner answers, and this page polls until the set reaches the exam's
 * length. Later visits reuse the cached set outright. The run itself lives in
 * PracticeRunner; this page owns loading, the flag/got-it mutations, and the
 * completion screen.
 */
const POLL_MS = 4000
export default function PracticeMode() {
  const { domainId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()

  // A practice set is keyed by its domain; answers are already recorded
  // server-side, so this only keeps the learner's place.
  const attempt = useAttempt('practice', domainId)
  const [done, setDone] = useState(false)
  const [flagged, setFlagged] = useState(0)
  // What they actually scored. The runner already knows — every answer was
  // graded server-side as it was given — and the completion screen was
  // throwing it away and reporting a count of questions instead.
  const [scored, setScored] = useState(null)

  const { data, isPending, error } = useQuery({
    queryKey: ['practice-questions', domainId],
    queryFn: ({ signal }) => api.practiceQuestions(domainId, {}, signal),
    retry: false,
    // The set arrives in two parts: enough questions to start with, then the
    // rest behind them. Poll while the server says it's still writing, so the
    // run grows underneath the learner instead of making them wait for it.
    refetchInterval: (query) => (query.state.data?.generating ? POLL_MS : false),
    refetchIntervalInBackground: false,
  })

  const flag = useMutation({
    mutationFn: (qid) => api.flagQuestion(qid),
    onError: (e) => toast.error(e?.message || 'Could not flag that question'),
  })
  const gotIt = useMutation({
    mutationFn: (qid) => api.gotItQuestion(qid),
  })

  const questions = Array.isArray(data?.questions) ? data.questions : []
  // From the set, not from a question.
  //
  // This read `questions[0]?.module_id`, and a practice question has never
  // carried one — it carries its domain, which is the right shape for a
  // question. So this was always `undefined`, `useSessionFinish` returned at
  // its first line, and a finished run wrote no session record, offered no
  // missed-questions prompt and left no trace of the attempt. Silently, every
  // time. The set carries the module now, because the end of a sitting is
  // module-level work.
  const finishSession = useSessionFinish(data?.module_id)
  const target = data?.target_count || questions.length
  const generating = !!data?.generating
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
          scored={scored}
          flagged={flagged}
          onReview={() => navigate(path('reviewLater', { domainId }))}
          onAgain={() => {
            attempt.clear()
            setDone(false)
            setFlagged(0)
            setScored(null)
          }}
        />
      ) : (
        <PracticeRunner
          questions={questions}
          attempt={attempt}
          total={target}
          awaitingMore={generating}
          mode="practice"
          onSubmit={(q, chosen) => api.submitAnswer(q.id, chosen)}
          onFlag={handleFlag}
          onGotIt={handleGotIt}
          onComplete={complete}
          onFinished={({ results }) => {
            setScored(summarise(results))
            return finishSession({
              kind: 'practice', itemId: domainId,
              title: 'Practice set', results,
            })
          }}
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
          Writing a full-length set — as many questions as your real exam — with
          an explanation for every option. This takes a minute, then it&rsquo;s
          cached.
        </p>
      </div>
    </div>
  )
}

function CompleteScreen({ total, scored, flagged, onReview, onAgain }) {
  const pct = scored?.total ? Math.round((scored.correct / scored.total) * 100) : null
  return (
    <div className="card flex flex-col items-center gap-5 py-12 text-center">
      <div className={`flex size-16 items-center justify-center rounded-full ${
        pct == null ? 'bg-success' : pct >= 70 ? 'bg-success' : pct >= 40 ? 'bg-accent' : 'bg-warning'
      }`}>
        {pct == null ? (
          <GraduationCap size={30} className="text-white" aria-hidden="true" />
        ) : (
          <span className="text-xl font-bold text-white">{pct}%</span>
        )}
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-pri">Practice complete</h2>
        {/* The score first, because it is what forty minutes of answering was
            for. The count is context, not the result. */}
        {scored?.total ? (
          <p className="text-sm text-pri">
            {scored.correct} of {scored.total} correct
          </p>
        ) : null}
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
