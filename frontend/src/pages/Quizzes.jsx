import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Play, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import GenerateForm from '../components/study/GenerateForm'
import QuizRunner from '../components/study/QuizRunner'
import { useAttempt } from '../hooks/useAttempt'
import PageTitle from '../components/PageTitle'
import { useConfirm } from '../hooks/useConfirm'
import { useToast } from '../hooks/useToast'
import { api, ApiError } from '../lib/api'
import { useSessionFinish } from '../hooks/useSessionFinish'

/**
 * Quizzes for a domain — spec Prompt 6.6.
 *
 * Lists the domain's quizzes; picking one runs it. When none exist (or the
 * learner asks for more), the generate form appears.
 */
export default function Quizzes() {
  const { domainId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const toast = useToast()
  const [active, setActive] = useState(null) // a quiz being run
  const [showForm, setShowForm] = useState(false)

  const { data, isPending, error } = useQuery({
    queryKey: ['quizzes', domainId],
    queryFn: ({ signal }) => api.quizzes(domainId, signal),
  })

  const generate = useMutation({
    mutationFn: ({ difficulty, count }) =>
      api.generateQuiz({ domain_id: domainId, difficulty, question_count: count }),
    onSuccess: (quiz) => {
      queryClient.invalidateQueries({ queryKey: ['quizzes', domainId] })
      setShowForm(false)
      setActive(quiz) // jump straight into the fresh quiz
    },
    onError: (e) => toast.error(e?.message || 'Could not make a quiz'),
  })

  const remove = useMutation({
    mutationFn: (id) => api.deleteQuiz(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quizzes', domainId] })
      toast.success('Quiz deleted')
    },
    onError: (e) => toast.error(e?.message || 'Could not delete quiz'),
  })

  async function confirmDelete(quiz) {
    const ok = await confirm({
      title: 'Delete quiz?',
      message: `"${quiz.title}" and its recorded scores will be removed.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) remove.mutate(quiz.id)
  }

  // Submit the run for the authoritative score, then confirm it was recorded.
  async function submitQuiz(quiz, answers) {
    const result = await api.submitQuiz(quiz.id, answers)
    queryClient.invalidateQueries({ queryKey: ['quizzes', domainId] })
    toast.success(`Quiz score saved · ${Math.round(result.score)}%`)
    return result
  }

  const quizzes = Array.isArray(data) ? data : []
  const isAuth = error instanceof ApiError && error.isAuth

  // --- Running a quiz -------------------------------------------------------
  if (active) {
    return (
      <div className="space-y-6">
        <PageTitle onBack={() => setActive(null)} backLabel="All quizzes">
          {active.title}
        </PageTitle>
        <ResumableQuiz quiz={active} onSubmit={submitQuiz} />
      </div>
    )
  }

  // --- Listing / generating -------------------------------------------------
  return (
    <div className="space-y-6">
      <PageTitle
        onBack={() => navigate(-1)}
        subtitle="Test yourself on this domain."
        actions={
          quizzes.length > 0 &&
          !showForm && (
            <button onClick={() => setShowForm(true)} className="btn-secondary">
              <Plus size={16} aria-hidden="true" />
              New quiz
            </button>
          )
        }
      >
        Quizzes
      </PageTitle>

      {isPending ? (
        <div className="space-y-3" role="status" aria-label="Loading">
          <div className="skeleton h-16 rounded-2xl" />
          <div className="skeleton h-16 rounded-2xl" />
        </div>
      ) : isAuth ? (
        <p className="card text-center text-sm text-sec">Sign in to take quizzes.</p>
      ) : quizzes.length === 0 || showForm ? (
        <GenerateForm
          kind="quiz"
          onGenerate={generate.mutate}
          generating={generate.isPending}
          error={generate.error?.message}
          onDismissError={generate.reset}
        />
      ) : (
        <div className="space-y-3">
          {quizzes.map((quiz) => (
            <div key={quiz.id} className="card-interactive flex items-center gap-3">
              <button
                onClick={() => setActive(quiz)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent2">
                  <Play size={16} className="ml-0.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-pri">{quiz.title}</p>
                  <p className="text-xs text-sec">
                    {quiz.question_count} questions
                    {quiz.score != null && ` · last score ${Math.round(quiz.score)}%`}
                  </p>
                </div>
              </button>
              <button
                onClick={() => confirmDelete(quiz)}
                aria-label="Delete quiz"
                className="btn-ghost size-11 rounded-full p-0 hover:text-warning"
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
              <ChevronRight size={16} className="shrink-0 text-sec" aria-hidden="true" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One quiz, with its place kept.
 *
 * Split out because the attempt is keyed by quiz id: mounting it only once a
 * quiz is open keeps the hook unconditional and starts a clean run per quiz.
 */
function ResumableQuiz({ quiz, onSubmit }) {
  const attempt = useAttempt('quiz', quiz.id)
  // The module comes from the quiz rather than the route: quizzes are opened by
  // domain, and a container belongs to the module above it.
  const finishSession = useSessionFinish(quiz.module_id)
  if (attempt.loading) return <div className="skeleton h-40 rounded-2xl" />
  return (
    <QuizRunner
      quiz={quiz}
      attempt={attempt}
      onSubmit={(answers) => onSubmit(quiz, answers)}
      onFinished={({ results }) =>
        finishSession({
          kind: 'quiz', itemId: quiz.id, title: quiz.title, results,
        })
      }
    />
  )
}
