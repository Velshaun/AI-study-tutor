import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, ListChecks, Loader2 } from 'lucide-react'
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
 * Length and timing are chosen the same way, and the recommendation cascades
 * per module. On a module's first exam, Recommended is the real paper — the
 * published question count and time limit for the certification it's about, or
 * a generic hour when nothing matched. Custom takes whatever the learner has
 * time for, from half a paper on a lunch break to a multi-hour LSAT sitting;
 * once set, that value is saved to the module and becomes the Recommended
 * prefill for every later exam in it — still an editable field, and still one
 * tap away from the published spec. Other modules are unaffected.
 *
 * Once generated, the exam runs through the shared QuizRunner (identical
 * question shape), which counts the timer down and submits for an
 * authoritative recorded score.
 */

const DIFFICULTIES = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
]

const MAX_QUESTIONS = 100
const MAX_MINUTES = 600

export default function PracticeExam() {
  const { moduleId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()

  const [difficulty, setDifficulty] = useState('medium')
  // null = follow the module's exam length; a boolean once the learner flips.
  const [includeChoice, setIncludeChoice] = useState(null)
  const [exam, setExam] = useState(null)

  // 'recommended' | 'custom'. The typed values start as null — meaning "not
  // touched yet", so the inputs prefill from the module's current numbers
  // rather than starting blank — and hold a string once the learner types.
  const [countMode, setCountMode] = useState('recommended')
  const [timerMode, setTimerMode] = useState('recommended')
  const [customCount, setCustomCount] = useState(null)
  const [customMinutes, setCustomMinutes] = useState(null)

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

  const module = moduleQuery.data
  // What this module recommends *now*: the learner's own saved length once they
  // have set one, otherwise the published spec (see exam_profile_source).
  const baseline = module?.recommended_exam
  const recommendedCount = module?.practice_question_count || baseline?.question_count || 20
  const recommendedMinutes = module?.practice_duration_minutes || baseline?.duration_minutes || 60
  const source = module?.exam_profile_source || 'generic'
  const isCustomised = source === 'custom'

  // Untouched inputs show the current numbers, so Custom starts from where the
  // learner already is instead of an empty box.
  const countInput = customCount ?? String(recommendedCount)
  const minutesInput = customMinutes ?? String(recommendedMinutes)

  const count = countMode === 'custom' ? clampInt(countInput, MAX_QUESTIONS) : recommendedCount
  const minutes = timerMode === 'custom' ? clampInt(minutesInput, MAX_MINUTES) : recommendedMinutes
  const ready = count > 0 && minutes > 0
  const changed =
    count !== module?.practice_question_count || minutes !== module?.practice_duration_minutes

  const generate = useMutation({
    mutationFn: async () => {
      // Only write when the numbers actually move. Starting a Recommended run
      // shouldn't pin the module to today's catalogue value.
      if (changed) {
        await api.setExamProfile(moduleId, {
          exam_question_count: count,
          exam_duration_minutes: minutes,
        })
        queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      }
      return api.generateExam({
        module_id: moduleId,
        question_count: count,
        duration_minutes: minutes,
        difficulty,
        include_imported: includeImported,
      })
    },
    onSuccess: (result) => setExam(result),
    onError: (e) => toast.error(e?.message || 'Could not build the exam'),
  })

  // Clearing the saved numbers hands the module back to the published spec.
  const reset = useMutation({
    mutationFn: () =>
      api.setExamProfile(moduleId, {
        exam_question_count: null,
        exam_duration_minutes: null,
      }),
    onSuccess: () => {
      setCustomCount(null)
      setCustomMinutes(null)
      setCountMode('recommended')
      setTimerMode('recommended')
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      toast.success('Back to the published exam format')
    },
    onError: (e) => toast.error(e?.message || 'Could not restore the format'),
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
          <ModeField
            label="Questions"
            Icon={ListChecks}
            mode={countMode}
            onMode={setCountMode}
            recommendedValue={`${recommendedCount} questions`}
            note={countNote(source, baseline)}
            unit="questions"
            max={MAX_QUESTIONS}
            value={countInput}
            onValue={setCustomCount}
          />

          {/* Timer */}
          <ModeField
            label="Timer"
            Icon={Clock}
            mode={timerMode}
            onMode={setTimerMode}
            recommendedValue={`${recommendedMinutes} minutes`}
            note={timerNote(source, baseline)}
            unit="minutes"
            max={MAX_MINUTES}
            value={minutesInput}
            onValue={setCustomMinutes}
          />

          {/* One tap back to the real paper, so a saved length is never a
              one-way door. */}
          {isCustomised && baseline?.matched && (
            <button
              onClick={() => reset.mutate()}
              disabled={reset.isPending}
              className="text-xs text-accent2 underline-offset-2 hover:underline"
            >
              {reset.isPending ? 'Restoring…' : `Use the published ${baseline.label} format instead (${baseline.question_count} questions, ${baseline.duration_minutes} min)`}
            </button>
          )}

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

          <div className="space-y-2">
            <button
              onClick={() => generate.mutate()}
              disabled={generate.isPending || !ready}
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
            {ready && (
              <p className="text-center text-xs text-sec">
                {count} question{count === 1 ? '' : 's'} · {minutes} minute
                {minutes === 1 ? '' : 's'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** A whole number within bounds, or 0 when the box is empty or nonsense. */
function clampInt(raw, max) {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return 0
  return Math.min(n, max)
}

/** Whose numbers the Recommended tile is showing, for the count. */
function countNote(source, baseline) {
  if (source === 'custom') {
    return 'Your saved length for this module — change it any time'
  }
  if (!baseline?.matched) {
    return 'No certification matched — a standard practice length'
  }
  return baseline.published
    ? `The published ${baseline.label} format`
    : `Typical for ${baseline.label}`
}

/** The same, for the timer. */
function timerNote(source, baseline) {
  if (source === 'custom') {
    return 'Your saved time limit for this module — change it any time'
  }
  return baseline?.matched
    ? `The real ${baseline.label} time limit`
    : 'A standard hour for a practice sitting'
}

/**
 * A setting with a Recommended option (the real exam's value) and a Custom one
 * (whatever the learner has time for). Custom reveals a single number input,
 * so the common case stays one tap.
 */
function ModeField({
  label, Icon, mode, onMode, recommendedValue, note, unit, max, value, onValue,
}) {
  const invalid = mode === 'custom' && value !== '' && clampInt(value, max) === 0

  return (
    <Field label={label}>
      <div className="grid grid-cols-2 gap-2">
        <Choice active={mode === 'recommended'} onClick={() => onMode('recommended')}>
          <span className="flex flex-col items-center leading-tight">
            <span>Recommended</span>
            <span className="text-xs font-normal text-sec">{recommendedValue}</span>
          </span>
        </Choice>
        <Choice active={mode === 'custom'} onClick={() => onMode('custom')}>
          <span className="flex flex-col items-center leading-tight">
            <span>Custom</span>
            <span className="text-xs font-normal text-sec">Choose your own</span>
          </span>
        </Choice>
      </div>

      {mode === 'recommended' ? (
        <p className="flex items-center gap-1.5 text-xs text-sec">
          <Icon size={12} aria-hidden="true" />
          {note}
        </p>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              max={max}
              inputMode="numeric"
              value={value}
              onChange={(e) => onValue(e.target.value)}
              aria-label={`Custom ${unit}`}
              className="w-28 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-pri"
            />
            <span className="text-sm text-sec">{unit}</span>
          </div>
          <p className="text-xs text-sec">
            {invalid ? `Enter a number between 1 and ${max}.` : `Up to ${max}.`}
          </p>
        </div>
      )}
    </Field>
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
