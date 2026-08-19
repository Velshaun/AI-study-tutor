import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import Modal from '../Modal'
import { usePreferences } from '../../hooks/usePreferences'

/**
 * What to build, asked once before anything is generated.
 *
 * Each media type gets only the settings that mean something for it: a quiz has
 * a difficulty, a practice exam deliberately doesn't (it should mirror the real
 * paper), and a lecture has a voice and a length instead of a count. Defaults
 * come from the learner's saved preferences and, for a practice exam, from the
 * published spec for the certification this module is about — so the common
 * case is open, glance, Generate.
 */

const LENGTHS = [
  { value: 'short', label: 'Short', hint: '~5 min' },
  { value: 'medium', label: 'Medium', hint: '~10 min' },
  { value: 'long', label: 'Long', hint: '~20 min' },
]
const TUTORS = [
  { value: 'sophia', label: 'Sophia' },
  { value: 'marcus', label: 'Marcus' },
]
const DIFFICULTIES = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
]

const CARD_MIN = 5
const CARD_MAX = 500
const CARD_STEP = 5

export default function GeneratePreferencesModal({
  open, kind, label, domainCount = 1, recommendedExamCount = 40, onClose, onGenerate,
}) {
  const { preferences } = usePreferences()

  const [voice, setVoice] = useState(preferences.tutor_voice || 'sophia')
  const [length, setLength] = useState(preferences.lecture_length || 'medium')
  const [difficulty, setDifficulty] = useState(preferences.quiz_difficulty || 'medium')
  const [quizCount, setQuizCount] = useState('10')
  const [examCount, setExamCount] = useState(String(recommendedExamCount))
  const [cards, setCards] = useState('50')
  const [submitting, setSubmitting] = useState(false)

  // The number the learner typed, bounded — 0 means "not a usable number yet".
  const bounded = (raw, min, max) => {
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n < min) return 0
    return Math.min(n, max)
  }

  const values = {
    lecture: { voice, length },
    quiz: { difficulty, count: bounded(quizCount, 1, 100) },
    practice: { count: bounded(examCount, 1, 100) },
    flashcards: { count: bounded(cards, CARD_MIN, CARD_MAX) },
  }[kind] || {}

  const ready = kind === 'lecture' || values.count > 0

  async function submit() {
    if (!ready || submitting) return
    setSubmitting(true)
    // The modal closes immediately — generation carries on in the background.
    onGenerate(values)
    setSubmitting(false)
  }

  const perDomain = (total) =>
    domainCount > 1
      ? ` · about ${Math.max(1, Math.round(total / domainCount))} per domain`
      : ''

  return (
    <Modal open={open} title={`Generate ${label.toLowerCase()}`} onClose={onClose}>
      <div className="space-y-5">
        {kind === 'lecture' && (
          <>
            <Field label="Tutor">
              <div className="grid grid-cols-2 gap-2">
                {TUTORS.map((t) => (
                  <Choice
                    key={t.value}
                    active={voice === t.value}
                    onClick={() => setVoice(t.value)}
                  >
                    {t.label}
                  </Choice>
                ))}
              </div>
            </Field>
            <Field label="Duration">
              <div className="grid grid-cols-3 gap-2">
                {LENGTHS.map((l) => (
                  <Choice key={l.value} active={length === l.value} onClick={() => setLength(l.value)}>
                    <span className="block">{l.label}</span>
                    <span className="block text-xs font-normal text-sec">{l.hint}</span>
                  </Choice>
                ))}
              </div>
            </Field>
          </>
        )}

        {kind === 'quiz' && (
          <>
            <Field label="Questions" hint={`Across ${domainCount} domain${domainCount === 1 ? '' : 's'}${perDomain(values.count)}`}>
              <NumberInput value={quizCount} onChange={setQuizCount} min={1} max={100} unit="questions" />
            </Field>
            <Field label="Difficulty">
              <div className="grid grid-cols-3 gap-2">
                {DIFFICULTIES.map((d) => (
                  <Choice key={d.value} active={difficulty === d.value} onClick={() => setDifficulty(d.value)}>
                    {d.label}
                  </Choice>
                ))}
              </div>
            </Field>
            <p className="text-xs text-sec">Quizzes are untimed — take as long as you need.</p>
          </>
        )}

        {kind === 'practice' && (
          <Field
            label="Questions"
            hint={`Recommended: ${recommendedExamCount}, matching the real exam`}
          >
            <NumberInput value={examCount} onChange={setExamCount} min={1} max={100} unit="questions" />
            <p className="text-xs text-sec">
              No difficulty setting — a practice exam mirrors the real paper.
            </p>
          </Field>
        )}

        {kind === 'flashcards' && (
          <Field
            label="Cards"
            hint={`${values.count || CARD_MIN} card${values.count === 1 ? '' : 's'}${perDomain(values.count)}`}
          >
            <input
              type="range"
              min={CARD_MIN}
              max={CARD_MAX}
              step={CARD_STEP}
              value={values.count || CARD_MIN}
              onChange={(e) => setCards(e.target.value)}
              aria-label="Number of cards"
              className="w-full accent-[var(--color-accent)]"
            />
            <div className="flex items-center justify-between text-xs text-sec">
              <span>{CARD_MIN}</span>
              <span>{CARD_MAX}</span>
            </div>
            {/* Typed entry as well as the slider: 500 steps of 5 is a long drag
                for someone who knows they want 120. */}
            <NumberInput
              value={cards}
              onChange={setCards}
              min={CARD_MIN}
              max={CARD_MAX}
              unit="cards"
            />
          </Field>
        )}

        <button onClick={submit} disabled={!ready || submitting} className="btn-primary w-full">
          {submitting ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : null}
          Generate
        </button>
      </div>
    </Modal>
  )
}

function NumberInput({ value, onChange, min, max, unit }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Number of ${unit}`}
        className="w-24 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-pri"
      />
      <span className="text-sm text-sec">{unit}</span>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wider text-sec">{label}</p>
      {children}
      {hint && <p className="text-xs text-sec">{hint}</p>}
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
