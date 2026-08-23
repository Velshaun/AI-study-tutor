import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'

import PageTitle from '../components/PageTitle'
import QuizRunner from '../components/study/QuizRunner'
import { useAttempt } from '../hooks/useAttempt'
import { useSessionFinish } from '../hooks/useSessionFinish'
import { useToast } from '../hooks/useToast'
import { ApiError, api } from '../lib/api'

/**
 * Sit one quiz, opened by its own id.
 *
 * The domain-scoped screen lists a domain's quizzes and runs whichever is
 * picked, which cannot express a quiz built from a container — its questions
 * come from every domain, so there is no domain to list it under. Same runner,
 * same finish, one paper.
 */
export default function QuizById() {
  const { quizId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const attempt = useAttempt('quiz', quizId)

  const { data: quiz, isPending, error } = useQuery({
    queryKey: ['quiz', quizId],
    queryFn: ({ signal }) => api.quizById(quizId, signal),
  })

  const finishSession = useSessionFinish(quiz?.module_id)

  async function submit(answers) {
    const result = await api.submitQuiz(quizId, answers)
    queryClient.invalidateQueries({ queryKey: ['studio', quiz?.module_id] })
    queryClient.invalidateQueries({ queryKey: ['container', quiz?.module_id, 'missed'] })
    toast.success(`Quiz score saved · ${Math.round(result.score)}%`)
    return result
  }

  if (isPending || attempt.loading) {
    return (
      <div className="space-y-4 p-1">
        <div className="skeleton h-7 w-48" />
        <div className="card space-y-3">
          <div className="skeleton h-4 w-3/4" />
          <div className="skeleton h-10" />
          <div className="skeleton h-10" />
        </div>
      </div>
    )
  }

  if (error) {
    const isAuth = error instanceof ApiError && error.isAuth
    return (
      <p className="card text-center text-sm text-sec">
        {isAuth ? 'Sign in to take this quiz.' : 'That quiz could not be opened.'}
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <PageTitle
        onBack={() => navigate(-1)}
        subtitle={`${quiz.question_count} questions from what you got wrong`}
      >
        {quiz.title}
      </PageTitle>
      <QuizRunner
        quiz={quiz}
        attempt={attempt}
        onSubmit={submit}
        // Cycling back through what was missed is the point of a review set.
        retryWrong
        onRestart={() => navigate(-1)}
        onFinished={({ results }) =>
          finishSession({
            kind: 'quiz', itemId: quiz.id, title: quiz.title, results,
          })
        }
      />
    </div>
  )
}
