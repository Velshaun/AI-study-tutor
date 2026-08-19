import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'

import PageTitle from '../components/PageTitle'
import QuizRunner from '../components/study/QuizRunner'
import { useToast } from '../hooks/useToast'
import { ApiError, api } from '../lib/api'

/**
 * Sit a stored practice exam.
 *
 * Generated and imported exams live in the same tables and open through the
 * same runner — an imported paper is meant to be indistinguishable from one the
 * app wrote, so there is deliberately nothing here that tells them apart.
 */
export default function ExamRun() {
  const { examId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()

  const { data: exam, isPending, error } = useQuery({
    queryKey: ['exam', examId],
    queryFn: ({ signal }) => api.exam(examId, signal),
  })

  async function submit(answers) {
    const result = await api.submitExam(examId, answers)
    toast.success(`Exam score saved · ${Math.round(result.score)}%`)
    return result
  }

  if (isPending) {
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
        {isAuth ? 'Sign in to sit this exam.' : 'That exam could not be opened.'}
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <PageTitle
        onBack={() => navigate(-1)}
        backLabel="Exit exam"
        subtitle={`${exam.question_count} questions${
          exam.duration_minutes ? ` · ${exam.duration_minutes} min` : ''
        }`}
      >
        {exam.title}
      </PageTitle>
      <QuizRunner quiz={exam} onSubmit={submit} onRestart={() => navigate(-1)} />
    </div>
  )
}
