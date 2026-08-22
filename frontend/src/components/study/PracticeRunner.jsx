import {
  CheckCheck, CheckCircle, ChevronLeft, Flag, Lightbulb, Loader2, Lock, XCircle,
} from 'lucide-react'
import { useState } from 'react'

import { planExpansions } from '../../lib/terms'
import ErrorBanner from '../ErrorBanner'
import QuestionNavigator from './QuestionNavigator'
import TermSheet from './TermSheet'
import TermText from './TermText'
import { toResults } from '../../lib/session'
import FlagToggle from './FlagToggle'

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
 * Answering is forward-only, and going back is reading, not a second attempt.
 * Unlike the quiz and exam runner, this one's answers are recorded on the
 * server the moment they are given — there is no final submission to revise
 * before. So Previous and the navigator take a learner back to re-read a
 * question and its Why Card with the answer they gave still marked, and the
 * options locked. Nothing there rewrites what was recorded.
 *
 * The navigator only offers questions this session actually answered. A resumed
 * run knows its position and nothing else, so the ones answered yesterday stay
 * shut rather than reopening as though they had never been answered.
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
  onFinished,
  attempt,
}) {
  // Answers are already recorded server-side as each is submitted, so only the
  // learner's place in the set needs keeping.
  // Session flags, exactly as in the other runners. Distinct from `onFlag`,
  // which is the older Review Later button and writes to the server on press.
  const [flags, setFlags] = useState(() => new Set())
  const toggleFlag = (at) =>
    setFlags((prev) => {
      const next = new Set(prev)
      if (next.has(at)) next.delete(at)
      else next.add(at)
      return next
    })
  const [index, setIndex] = useState(() =>
    Math.min(attempt?.restored?.position ?? 0, Math.max(0, questions.length - 1)),
  )
  // What was answered, by question index. Practice mode records each answer on
  // the server as it is given, so this is not the record — it is what lets a
  // learner look back at one without the app having to ask for it again.
  const [history, setHistory] = useState({}) // { [i]: { selected, revealed } }
  // The pick on the live question, before it is submitted. Kept apart from
  // `history` because it is the one thing here that is still changeable.
  const [draft, setDraft] = useState(null) // chosen label, e.g. 'B'
  // How far the run has got. Anything before this is answered and settled.
  const [furthest, setFurthest] = useState(() =>
    Math.min(attempt?.restored?.position ?? 0, Math.max(0, questions.length - 1)),
  )
  const [visited, setVisited] = useState(
    () => new Set([Math.min(attempt?.restored?.position ?? 0, Math.max(0, questions.length - 1))]),
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [openTerm, setOpenTerm] = useState(null)

  const count = Math.max(total || 0, questions.length)
  const q = questions[index]

  // Looking back at something already answered. The answer stands: it went to
  // the server when it was given, and nothing here rewrites it — going back is
  // for reading the explanation again, not for a second attempt.
  const reviewing = index < furthest
  const past = history[index]
  const selected = past ? past.selected : draft
  const revealed = past ? past.revealed : null
  const answers = Array.from({ length: count }, (_, i) => history[i]?.selected ?? null)
  // The learner has answered everything written so far. `index` is allowed to
  // sit one past the end while the server writes more: the next question
  // renders itself the moment it lands, with no effect to synchronise.
  const caughtUp = !q && index > 0

  if (!q && !caughtUp) return null

  async function submit() {
    if (reviewing || draft == null || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await onSubmit(q, draft)
      setHistory((seen) => ({ ...seen, [index]: { selected: draft, revealed: result } }))
    } catch (e) {
      setError(e?.message || 'Could not submit your answer.')
    } finally {
      setSubmitting(false)
    }
  }

  /** What has been chosen so far, in question order.
   *
   *  Saved with the position because the position alone was never enough: a
   *  practice answer is posted as it is given and stored nowhere, so a run that
   *  ends without its results reaching anything leaves no record of what was
   *  answered at all. This is the only durable copy.
   */
  function chosenSoFar() {
    return Array.from({ length: questions.length }, (_, i) => history[i]?.selected ?? null)
  }

  function advance() {
    setDraft(null)
    setError(null)
    // Stepping past the last written question is fine while the set is still
    // being written — the run parks on a waiting card until the next lands.
    if (index < questions.length - 1 || awaitingMore) {
      const to = index + 1
      setIndex(to)
      setFurthest(to)
      setVisited((seen) => new Set(seen).add(to))
      attempt?.save?.({ position: to, answers: chosenSoFar(), completed: to >= questions.length })
    } else {
      attempt?.save?.({
        position: questions.length, answers: chosenSoFar(), completed: true,
      })
      // Practice mode's answers were posted as they were given, so the session
      // record is assembled from what came back rather than from a final
      // submission — there isn't one.
      onFinished?.({
        results: toResults({
          questions,
          answers: Array.from({ length: questions.length },
            (_, i) => history[i]?.selected ?? null),
          flags,
          correctIndexOf: (_q, i) => history[i]?.revealed?.correct_option ?? null,
          promptOf: (question) => question?.question ?? question?.prompt ?? '',
        }).map((row, i) => ({
          ...row,
          correct: Boolean(history[i]?.revealed?.is_correct),
          explanation: history[i]?.revealed?.why_summary || '',
          source_id: questions[i]?.id ?? null,
        })),
      })
      onComplete?.()
    }
  }

  /** Look at another question. Never changes what has been recorded.
   *
   *  Deliberately no `attempt.save`: the saved position is where the run is up
   *  to, and wandering back to read question two must not mean resuming there
   *  tomorrow.
   */
  function goTo(to) {
    if (to < 0 || to > furthest || to === index) return
    if (to !== furthest && !history[to]) return
    setError(null)
    setIndex(to)
    setVisited((seen) => new Set(seen).add(to))
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
        <div className="flex items-center justify-between text-xs text-sec">
          <span className="inline-flex items-center gap-1">
            Question {Math.min(index + 1, count)} of {count}
            <FlagToggle
              flagged={flags.has(index)}
              onToggle={() => toggleFlag(index)}
              className="-my-2 size-9"
            />
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
            style={{ width: `${((furthest + (revealed ? 1 : 0)) / count) * 100}%` }}
          />
        </div>
        <QuestionNavigator
          count={count}
          index={index}
          answers={answers}
          visited={visited}
          onJump={goTo}
          // Only backwards, and only to questions this session actually holds
          // the answer for. Forward is earned by answering, as it always was.
          canJump={(i) => i === furthest || (i < furthest && Boolean(history[i]))}
          locked
        />
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
                onChoose={() =>
                  !revealed && !reviewing && !openTerm && setDraft(opt.label)
                }
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
      ) : reviewing ? (
        <div className="space-y-2">
          <p className="flex items-center justify-center gap-1.5 text-center text-xs text-sec">
            <Lock size={12} aria-hidden="true" />
            Answered already — this one is recorded and can&rsquo;t be changed.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => goTo(index - 1)}
              disabled={index === 0 || !history[index - 1]}
              className="btn-secondary min-h-11 shrink-0 px-4 disabled:opacity-40"
            >
              <ChevronLeft size={16} aria-hidden="true" />
              Previous
            </button>
            <button onClick={() => goTo(furthest)} className="btn-primary min-h-11 flex-1">
              Back to question {Math.min(furthest + 1, count)}
            </button>
          </div>
        </div>
      ) : !revealed ? (
        <button
          onClick={submit}
          disabled={draft == null || submitting}
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

      {/* The way into review from the live question. Below the actions rather
          than beside them: answering is what this screen is for, and looking
          back is the aside. */}
      {!reviewing && !caughtUp && index > 0 && history[index - 1] && (
        <button
          onClick={() => goTo(index - 1)}
          className="btn-ghost mx-auto min-h-11 text-xs"
        >
          <ChevronLeft size={14} aria-hidden="true" />
          Review previous questions
        </button>
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
