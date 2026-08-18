import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Pencil } from 'lucide-react'
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
 *
 * The default length is the real paper's — `module.practice_question_count`,
 * which the backend resolves from the stated exam length or the largest
 * imported past paper. Shorter runs stay available for a quick session.
 */

const SHORT_COUNTS = [10, 20]
const DIFFICULTIES = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
]

export default function PracticeExam() {
  const { moduleId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()

  // null = follow the module's exam length; a number once the learner picks.
  const [countChoice, setCountChoice] = useState(null)
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

  // Full length = the real exam; the short options are for a quick session.
  const examLength = moduleQuery.data?.practice_question_count || 20
  const counts = [...new Set([...SHORT_COUNTS, examLength])].sort((a, b) => a - b)
  const count = countChoice ?? examLength

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
          {/* Question count — defaults to the real exam's length */}
          <Field label="Questions">
            <div className="grid grid-cols-3 gap-2">
              {counts.map((n) => (
                <Choice key={n} active={count === n} onClick={() => setCountChoice(n)}>
                  {n}
                  {n === examLength && (
                    <span className="ml-1 text-xs text-sec">full</span>
                  )}
                </Choice>
              ))}
            </div>
            <ExamLengthEditor
              moduleId={moduleId}
              examLength={examLength}
              isStated={!!moduleQuery.data?.exam_question_count}
              onSaved={() => {
                setCountChoice(null)
                queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
              }}
            />
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

/**
 * Sets `modules.exam_question_count` — the length of the paper the learner is
 * actually sitting. Everything that generates practice questions (this screen
 * and Practice mode) sizes itself from it, so it lives next to the count
 * choices rather than buried in settings.
 */
function ExamLengthEditor({ moduleId, examLength, isStated, onSaved }) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(examLength))

  const save = useMutation({
    mutationFn: () =>
      api.setExamProfile(moduleId, { exam_question_count: Number(value) }),
    onSuccess: () => {
      setEditing(false)
      toast.success(`Practice sets will now use ${Number(value)} questions`)
      onSaved?.()
    },
    onError: (e) => toast.error(e?.message || 'Could not save the exam length'),
  })

  const valid = Number(value) >= 1 && Number(value) <= 200

  if (!editing) {
    return (
      <button
        onClick={() => {
          setValue(String(examLength))
          setEditing(true)
        }}
        className="flex items-center gap-1.5 text-xs text-sec hover:text-pri"
      >
        <Pencil size={12} aria-hidden="true" />
        {isStated
          ? `Your exam is ${examLength} questions`
          : `Assuming a ${examLength}-question exam — set the real length`}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min="1"
        max="200"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Questions in the real exam"
        className="w-24 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-pri"
      />
      <button
        onClick={() => valid && save.mutate()}
        disabled={!valid || save.isPending}
        className="btn-secondary min-h-9 px-3 text-xs"
      >
        {save.isPending ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <Check size={14} aria-hidden="true" />
        )}
        Save
      </button>
      <button
        onClick={() => setEditing(false)}
        className="text-xs text-sec hover:text-pri"
      >
        Cancel
      </button>
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
