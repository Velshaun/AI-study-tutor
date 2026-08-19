import { CheckCheck, CheckCircle, Flag, Lightbulb, Loader2, XCircle } from 'lucide-react'
import { useState } from 'react'

import { planExpansions } from '../../lib/terms'
import ErrorBanner from '../ErrorBanner'
import TermSheet from './TermSheet'
import TermText from './TermText'

/**
 * Practice Exam Mode runner — spec 6.4 / Prompt 11.
 *
 * One question at a time with considered feedback:
 *  - Before submission: four tappable option cards, no timer, Submit enabled
 *    only once an option is chosen. No confidence buttons yet.
 *  - On submission: the answer is submitted to the server, which returns the
 *    correct option, every option's explanation (resolved cache-first) and the
 *    Why Card. Nothing about the answer is known client-side until then — no
 *    peeking. Correct = green/✓, the wrong pick = red/✗, the rest dimmed.
 *  - Two confidence buttons animate in.
 *
 * Two modes share the flow:
 *  - 'practice': LEFT = Flag for Review, RIGHT = Got It. One must be chosen.
 *  - 'review'  : a wrong answer keeps the question in the queue and just moves
 *    on; a right answer lets the learner Keep Reviewing (stays) or Got It
 *    (removed).
 *
 * `onSubmit(question, chosenLabel)` must resolve to the reveal:
 *   { correct_option, is_correct, options:[{label,text,explanation}], why_summary }
 */
export default function PracticeRunner({
  questions,
  mode = 'practice',
  // `total` is the set's eventual length and `awaitingMore` says the server is
  // still writing it — a full-length set streams in while the learner answers,
  // so the run must not finish early just because it has caught up.
  total,
  awaitingMore = false,
  onSubmit,
  onFlag,
  onGotIt,
  onComplete,
  attempt,
}) {
  // Answers are already recorded server-side as each is submitted, so only the
  // learner's place in the set needs keeping.
  const [index, setIndex] = useState(() =>
    Math.min(attempt?.restored?.position ?? 0, Math.max(0, questions.length - 1)),
  )
  const [selected, setSelected] = useState(null) // chosen label, e.g. 'B'
  const [revealed, setRevealed] = useState(null) // AnswerResult once submitted
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [openTerm, setOpenTerm] = useState(null)

  const count = Math.max(total || 0, questions.length)
  const q = questions[index]
  // The learner has answered everything written so far. `index` is allowed to
  // sit one past the end while the server writes more: the next question
  // renders itself the moment it lands, with no effect to synchronise.
  const caughtUp = !q && index > 0

  if (!q && !caughtUp) return null

  async function submit() {
    if (selected == null || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await onSubmit(q, selected)
      setRevealed(result)
    } catch (e) {
      setError(e?.message || 'Could not submit your answer.')
    } finally {
      setSubmitting(false)
    }
  }

  function advance() {
    setSelected(null)
    setRevealed(null)
    setError(null)
    // Stepping past the last written question is fine while the set is still
    // being written — the run parks on a waiting card until the next lands.
    if (index < questions.length - 1 || awaitingMore) {
      const to = index + 1
      setIndex(to)
      attempt?.save?.({ position: to, completed: to >= questions.length })
    } else {
      attempt?.save?.({ position: questions.length, completed: true })
      onComplete?.()
    }
  }

  function flagForReview() {
    onFlag?.(q.id)
    advance()
  }
  function gotIt() {
    onGotIt?.(q.id)
    advance()
  }

  // After the reveal, options come from the server payload (they carry the
  // explanations); before it, from the question itself.
  const options = revealed?.options?.length ? revealed.options : q?.options || []
  const terms = q?.terms || []
  // Acronyms expand once per question, on the first line that mentions them.
  const [questionExpand, ...optionExpand] = planExpansions(
    [q?.question_text || '', ...options.map((o) => o.text)], terms,
  )

  return (
    <div className="space-y-5">
      {/* Progress */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-sec">
          <span>
            Question {Math.min(index + 1, count)} of {count}
            {awaitingMore && questions.length < count && (
              <span className="ml-1.5 text-accent2">
                · {questions.length} ready
              </span>
            )}
          </span>
          {q?.is_flagged && mode === 'practice' && (
            <span className="inline-flex items-center gap-1 text-warning">
              <Flag size={11} aria-hidden="true" /> Flagged
            </span>
          )}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${((index + (revealed ? 1 : 0)) / count) * 100}%` }}
          />
        </div>
      </div>

      {/* Keyed, so changing question remounts this and replays the entrance.
          Nothing waits for an exit, so the next question is in the DOM the
          moment `index` changes. */}
      {q && (
        <div key={index} className="step-in space-y-4">
          <p className="text-lg font-medium text-pri">
            <TermText
              text={q.question_text}
              terms={terms}
              expand={questionExpand}
              onSelect={setOpenTerm}
            />
          </p>

          <div className="space-y-2.5">
            {options.map((opt, i) => (
              <OptionCard
                key={opt.label}
                option={opt}
                selected={selected === opt.label}
                revealed={!!revealed}
                isCorrect={revealed?.correct_option === opt.label}
                terms={terms}
                expand={optionExpand[i]}
                onTerm={setOpenTerm}
                onChoose={() => !revealed && !openTerm && setSelected(opt.label)}
              />
            ))}
          </div>

          {/* Why Card */}
          {revealed?.why_summary && (
            <div className="rounded-xl border border-accent/60 bg-accent/10 px-4 py-3">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent2">
                <Lightbulb size={13} aria-hidden="true" />
                Why
              </p>
              <p className="text-sm leading-relaxed text-pri">{revealed.why_summary}</p>
            </div>
          )}
        </div>
      )}

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {/* Actions */}
      {caughtUp ? (
        <div
          className="space-y-3 rounded-xl border border-border bg-surface px-4 py-4 text-center"
        >
          {awaitingMore ? (
            <>
              <p className="flex items-center justify-center gap-2 text-sm text-pri">
                <Loader2
                  size={16}
                  className="animate-spin text-accent"
                  aria-hidden="true"
                />
                Writing the next questions…
              </p>
              <p className="text-xs text-sec">
                You&rsquo;ve answered every question written so far —{' '}
                {questions.length} of {count}. The next one appears here as soon
                as it lands.
              </p>
            </>
          ) : (
            <p className="text-sm text-pri">
              That&rsquo;s every question in this set.
            </p>
          )}
          <button
            onClick={() => onComplete?.()}
            className={`mx-auto min-h-11 ${awaitingMore ? 'btn-secondary' : 'btn-primary'}`}
          >
            {awaitingMore ? 'Finish here instead' : 'Finish'}
          </button>
        </div>
      ) : !revealed ? (
        <button
          onClick={submit}
          disabled={selected == null || submitting}
          className="btn-primary min-h-11 w-full"
        >
          {submitting ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              Checking…
            </>
          ) : (
            'Submit answer'
          )}
        </button>
      ) : (
        <Actions
          mode={mode}
          isCorrect={revealed.is_correct}
          onFlag={flagForReview}
          onGotIt={gotIt}
          onNext={advance}
        />
      )}

      <TermSheet term={openTerm} onClose={() => setOpenTerm(null)} />
    </div>
  )
}

function Actions({ mode, isCorrect, onFlag, onGotIt, onNext }) {
  // Review mode, wrong answer: stays in the queue automatically — one neutral
  // Next, no confidence choice.
  if (mode === 'review' && !isCorrect) {
    return (
      <div className="space-y-2">
        <p className="text-center text-xs text-sec">
          Kept in Review Later — you&rsquo;ll see this one again.
        </p>
        <button onClick={onNext} className="btn-secondary min-h-11 w-full">
          Next question
        </button>
      </div>
    )
  }

  const leftLabel = mode === 'review' ? 'Keep Reviewing' : 'Flag for Review'

  return (
    <div className="flex gap-3">
      <button
        onClick={onFlag}
        className="btn inline-flex min-h-11 flex-1 items-center justify-center gap-2
                   border border-warning/40 bg-warning/10 text-warning hover:bg-warning/15"
      >
        <Flag size={16} aria-hidden="true" />
        {leftLabel}
      </button>
      <button
        onClick={onGotIt}
        className="btn inline-flex min-h-11 flex-1 items-center justify-center gap-2
                   bg-success text-white hover:bg-success/90"
      >
        <CheckCheck size={16} aria-hidden="true" />
        Got It
      </button>
    </div>
  )
}

function OptionCard({
  option, selected, revealed, isCorrect, terms, expand, onTerm, onChoose,
}) {
  const wrongPick = revealed && selected && !isCorrect

  let tone = 'border-border bg-surface hover:border-accent/50'
  if (revealed && isCorrect) tone = 'border-success bg-success/10'
  else if (wrongPick) tone = 'border-warning bg-warning/10'
  else if (revealed) tone = 'border-border bg-surface opacity-60'
  else if (selected) tone = 'border-accent bg-accent/10'

  let badge = 'bg-surface2 text-sec'
  if (revealed && isCorrect) badge = 'bg-success text-white'
  else if (wrongPick) badge = 'bg-warning text-white'
  else if (selected) badge = 'bg-accent text-white'

  return (
    <button
      onClick={onChoose}
      disabled={revealed}
      className={`flex w-full flex-col gap-2 rounded-xl border px-4 py-3 text-left transition-colors ${tone}`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-lg text-sm font-semibold ${badge}`}
        >
          {option.label}
        </span>
        <span className="flex-1 text-sm text-pri">
          <TermText
            text={option.text}
            terms={terms}
            expand={expand}
            onSelect={onTerm}
          />
        </span>
        {revealed && isCorrect && (
          <CheckCircle size={18} className="shrink-0 text-success" aria-hidden="true" />
        )}
        {wrongPick && <XCircle size={18} className="shrink-0 text-warning" aria-hidden="true" />}
      </div>
      {/* Per-option explanation, revealed after submission */}
      {revealed && option.explanation && (
        <p className="pl-10 text-xs leading-relaxed text-sec">{option.explanation}</p>
      )}
    </button>
  )
}
