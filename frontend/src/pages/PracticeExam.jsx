import { useMutation, useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import ErrorBanner from '../components/ErrorBanner'
import PageTitle from '../components/PageTitle'
import QuizRunner from '../components/study/QuizRunner'
import Toggle from '../components/Toggle'
import { useToast } from '../hooks/useToast'
import { ApiError, api } from '../lib/api'

/**
 * Practice exam — spec Prompt 10c (item 7).
 *
 * Module-level and weighted: the generator allocates questions across the
 * module's domains by their blueprint weight, and (when the toggle is on and
 * imported sets exist) mixes in the learner's own imported questions. The route
 * param is the module id — a practice exam spans a module, not a single domain.
 *
 * Once generated, the exam runs through the shared QuizRunner (identical
 * question shape) and submits for an authoritative recorded score.
 */

const COUNTS = [10, 20, 30]
const DIFFICULTIES = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
]

export default function PracticeExam() {
  const { moduleId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()

  const [count, setCount] = useState(20)
  const [difficulty, setDifficulty] = useState('medium')
  // null = follow the default (on when imported questions exist); a boolean once
  // the learner flips the switch. Deriving the default avoids a setState-in-effect.
  const [includeChoice, setIncludeChoice] = useState(null)
  const [exam, setExam] = useState(null)

  const moduleQuery = useQuery({
    queryKey: ['module', moduleId],
    queryFn: ({ signal }) => api.module(moduleId, signal),
  })

  const importedQuery = useQuery({
    queryKey: ['imported', moduleId],
    queryFn: ({ signal }) => api.importedSets(moduleId, signal),
  })

  const importedSets = Array.isArray(importedQuery.data) ? importedQuery.data : []
  const importedCount = importedSets.reduce((n, s) => n + (s.question_count || 0), 0)
  const hasImported = importedCount > 0
  // On by default when imported questions exist, until the learner overrides it.
  const includeImported = (includeChoice ?? hasImported) && hasImported

  const generate = useMutation({
    mutationFn: () =>
      api.generateExam({
        module_id: moduleId,
        question_count: count,
        difficulty,
        include_imported: includeImported,
      }),
    onSuccess: (result) => setExam(result),
    onError: (e) => toast.error(e?.message || 'Could not build the exam'),
  })

  async function submitExam(answers) {
    const result = await api.submitExam(exam.id, answers)
    toast.success(`Exam score saved · ${Math.round(result.score)}%`)
    return result
  }

  // --- Running the exam -----------------------------------------------------
  if (exam) {
    return (
      <div className="space-y-6">
        <PageTitle
          onBack={() => setExam(null)}
          backLabel="Exit exam"
          subtitle={`${exam.question_count} questions${
            exam.duration_minutes ? ` · ${exam.duration_minutes} min` : ''
          }`}
        >
          {exam.title}
        </PageTitle>
        <QuizRunner
          quiz={exam}
          onSubmit={submitExam}
          onRestart={() => setExam(null)}
        />
      </div>
    )
  }

  const module = moduleQuery.data
  const isAuth = moduleQuery.error instanceof ApiError && moduleQuery.error.isAuth

  // --- Setup form -----------------------------------------------------------
  return (
    <div className="space-y-6">
      <PageTitle
        onBack={() => navigate(-1)}
        subtitle={
          module?.title
            ? `Weighted across ${module.title}`
            : 'Weighted to your blueprint'
        }
      >
        Practice exam
      </PageTitle>

      {isAuth ? (
        <p className="card text-center text-sm text-sec">Sign in to take an exam.</p>
      ) : (
        <div className="card space-y-6">
          {/* Question count */}
          <Field label="Questions">
            <div className="grid grid-cols-3 gap-2">
              {COUNTS.map((n) => (
                <Choice key={n} active={count === n} onClick={() => setCount(n)}>
                  {n}
                </Choice>
              ))}
            </div>
          </Field>

          {/* Difficulty */}
          <Field label="Difficulty">
            <div className="grid grid-cols-3 gap-2">
              {DIFFICULTIES.map((d) => (
                <Choice
                  key={d.value}
                  active={difficulty === d.value}
                  onClick={() => setDifficulty(d.value)}
                >
                  {d.label}
                </Choice>
              ))}
            </div>
          </Field>

          {/* Include imported questions */}
          <div className="flex items-center justify-between gap-4 rounded-xl bg-surface2/50 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-pri">Include imported questions</p>
              <p className="text-xs text-sec">
                {hasImported
                  ? `Mix in ${importedCount} question${importedCount === 1 ? '' : 's'} you imported`
                  : 'Import a practice-exam PDF to enable this'}
              </p>
            </div>
            <Toggle
              checked={includeImported}
              onChange={setIncludeChoice}
              disabled={!hasImported}
              label="Include imported questions"
            />
          </div>

          <ErrorBanner
            message={generate.error?.message}
            onDismiss={generate.reset}
          />

          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="btn-primary w-full"
          >
            {generate.isPending ? (
              <>
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                Building your exam…
              </>
            ) : (
              'Start exam'
            )}
          </button>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wider text-sec">{label}</p>
      {children}
    </div>
  )
}

function Choice({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={[
        'rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'border-accent bg-accent/10 text-pri'
          : 'border-border bg-surface text-sec hover:border-accent/50',
      ].join(' ')}
    >
      {children}
    </button>
  )
}
