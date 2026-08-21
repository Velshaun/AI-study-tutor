import { Check, ChevronLeft, Clock, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { planExpansions } from '../../lib/terms'
import { toResults } from '../../lib/session'
import FlagToggle from './FlagToggle'
import QuestionNavigator from './QuestionNavigator'
import ResultsGrid from './ResultsGrid'
import TermSheet from './TermSheet'
import TermText from './TermText'

/**
 * Quiz runner — spec Prompt 6.6.
 *
 * One question at a time, four options, with a Previous button and a navigator
 * strip so a learner can move around the paper rather than only forwards.
 *
 * Answering and being shown the answer are separate things here, and keeping
 * them separate is what makes moving around coherent:
 *
 *  - A **quiz** carries its answer key, so choosing an option reveals the
 *    correct one immediately and every option explains itself — a lucky guess
 *    still teaches the other three. That answer then stands: changing it after
 *    being told the right one would make the score, which feeds this module's
 *    domain strength, a number the learner had dictated.
 *  - An **exam** is sent without its key and says nothing until the paper is
 *    handed in, exactly as the real sitting does. Every answer stays editable
 *    until then, and the summary explains the lot.
 *
 * A score screen closes the run — or whatever `renderResult` supplies.
 *
 * When the exam carries a duration the run is timed: a countdown sits above the
 * progress bar and, at zero, the paper is submitted as it stands — the same
 * thing that happens in the real sitting.
 *
 * Key vocabulary and acronyms in the question are tappable: acronyms carry
 * their expansion inline on first mention, and any term opens a definition
 * sheet. That data is generated with the question, so it costs nothing to show.
 *
 * Progress is saved as it goes when the caller supplies `attempt`: leaving
 * mid-run and coming back reopens the same question with the same answers, and
 * a timed exam resumes with the clock where it was rather than reset.
 *
 * A caller that wants an exam to reveal as it goes can pass `onAnswer`, which
 * fetches one question's answer at a time; doing so also fixes that answer, by
 * the rule above. Either way the full set is submitted at the end for an
 * authoritative, server-side score.
 */

/** mm:ss for a countdown. */
function clock(totalSeconds) {
  const s = Math.max(0, totalSeconds)
  const mins = Math.floor(s / 60)
  const secs = s % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export default function QuizRunner({
  quiz, onSubmit, onRestart, attempt, renderResult, onAnswer, onFinished,
}) {
  const questions = quiz.questions || []
  const durationMinutes = quiz.duration_minutes || 0
  // Saved progress, read once when the run opens. `useState`'s initialiser is
  // what makes this a resume rather than a jump: the run starts where the
  // learner left off instead of starting over and correcting itself.
  const saved = attempt?.restored
  const [index, setIndex] = useState(() => Math.min(saved?.position ?? 0, Math.max(0, questions.length - 1)))
  const [answers, setAnswers] = useState(() => {
    const blank = questions.map(() => null)
    const previous = saved?.answers || []
    return blank.map((_, i) => (previous[i] === undefined ? null : previous[i]))
  })
  const [finished, setFinished] = useState(false)
  const [result, setResult] = useState(null)
  // A resumed exam keeps the clock it had; a fresh one starts at full length.
  const [remaining, setRemaining] = useState(() => {
    const deadline = saved?.state?.expires_at
    if (!deadline) return durationMinutes * 60
    const left = Math.round((new Date(deadline).getTime() - Date.now()) / 1000)
    return Number.isFinite(left) ? Math.max(0, left) : durationMinutes * 60
  })
  const [timedOut, setTimedOut] = useState(false)
  const [openTerm, setOpenTerm] = useState(null)
  // Session state until the confirmation prompt, so flagging costs nothing
  // and is undone by simply not confirming. Independent of the outcome:
  // flagging a question you then get right is the useful case.
  const [flags, setFlags] = useState(() => new Set())
  // Kept so the results screen can draw the tiles without recomputing
  // during render — the server's key only arrives with the submission.
  const [sessionResults, setSessionResults] = useState([])
  const toggleFlag = (at) =>
    setFlags((prev) => {
      const next = new Set(prev)
      if (next.has(at)) next.delete(at)
      else next.add(at)
      return next
    })
  // Answers revealed so far, by question index — only used where the paper
  // arrived without them and the caller asked for per-question reveals.
  const [revealed, setRevealed] = useState({})
  // Which questions have been looked at, so the navigator can tell "not been
  // there yet" from "been and left it blank". Seeded with wherever the run
  // opens, which on a resumed paper is not question one.
  const [visited, setVisited] = useState(
    () => new Set([Math.min(saved?.position ?? 0, Math.max(0, questions.length - 1))]),
  )

  // The countdown works from a fixed deadline rather than by decrementing, so a
  // backgrounded tab (where timers are throttled) still comes back honest.
  const deadlineRef = useRef(
    saved?.state?.expires_at ? new Date(saved.state.expires_at).getTime() : null,
  )
  // A mirror of `answers` that the timer can read: it fires from an interval,
  // long after the render that queued it, so it can't close over state.
  const answersRef = useRef(
    questions.map((_, i) => {
      const previous = saved?.answers || []
      return previous[i] === undefined ? null : previous[i]
    }),
  )
  const submittingRef = useRef(false)
  // Which questions have a reveal in flight. The effect below depends on the
  // `onAnswer` the caller passed, which is usually an inline arrow and so a new
  // function every render — without this, every render between asking and
  // answering would ask again.
  const revealingRef = useRef(new Set())

  const q = questions[index]
  const chosen = answers[index]

  // Where this question's answer comes from. A quiz ships its own; an exam
  // withholds it and hands it over one question at a time, once answered, so
  // that reading the network response can't raise a baseline score.
  const carried = q?.correct_index != null
  const answer = carried ? q : revealed[index] || {}
  const correctIndex = answer.correct_index ?? null
  const explanation = answer.explanation || ''

  const answered = chosen != null
  // Answered and *shown the answer* are different things, and separating them
  // is what makes going back coherent.
  //
  // A quiz carries its key, so answering reveals immediately — that is the
  // point of a study quiz. An exam withholds it and says nothing until the
  // paper is handed in, which is how the real sitting works and, more to the
  // point, is the only way "change your answer before you submit" can mean
  // anything: being able to revise an answer after being told the right one
  // would make a pre-assessment baseline a number the learner had dictated.
  const isRevealed = carried ? answered : revealed[index] !== undefined
  // So: an answer stands until its answer has been shown, and can be changed
  // freely until then.
  const canChange = !isRevealed
  const showState = isRevealed && correctIndex != null

  async function finish(answerList, { expired = false } = {}) {
    if (submittingRef.current) return
    submittingRef.current = true
    if (expired) setTimedOut(true)
    // The run is over: stop offering it as something to come back to.
    attempt?.save?.({ position: questions.length, answers: answerList, completed: true })
    const res = await onSubmit(answerList)
    setResult(res)
    setFinished(true)
    // Built here rather than in the results branch: `res` carries the
    // server's key, and the render path shouldn't be doing async bookkeeping.
    const rows = toResults({
        questions,
        answers: answerList,
        flags,
        correctIndexOf: (question, i) =>
          res?.results?.[i]?.correct_index ?? question?.correct_index ?? null,
        promptOf: (question) => question?.question ?? '',
    }).map((row, i) => ({
      ...row,
      explanation: res?.results?.[i]?.explanation || row.explanation,
    }))
    setSessionResults(rows)
    onFinished?.({ results: rows, result: res })
  }

  useEffect(() => {
    if (!durationMinutes || finished) return undefined
    if (deadlineRef.current == null) {
      deadlineRef.current = Date.now() + durationMinutes * 60 * 1000
    }
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000))
      setRemaining(left)
      if (left === 0) {
        clearInterval(id)
        // Time's up: hand in the paper exactly as it stands.
        finish(answersRef.current, { expired: true })
      }
    }, 1000)
    return () => clearInterval(id)
    // `finish` is stable enough for this: it guards itself with a ref, and the
    // answers it submits are read from a ref at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMinutes, finished])

  // Fetch the answer for an answered question the paper didn't carry one for.
  //
  // Keyed on the question rather than fired from the tap, so it covers every
  // way of arriving at an answered question: choosing an option, stepping back
  // to one, and resuming a run that was left half-finished.
  useEffect(() => {
    if (!onAnswer || !answered || carried) return
    if (revealed[index] !== undefined || chosen == null) return
    if (revealingRef.current.has(index)) return

    const asking = index
    revealingRef.current.add(asking)
    onAnswer({ index: asking, chosenIndex: chosen })
      .then((data) => setRevealed((cur) => ({ ...cur, [asking]: data })))
      .catch(() =>
        // The choice stands and the paper still grades server-side on submit;
        // only this question's explanation is missing, so let the run carry on
        // rather than blocking it on an unanswerable request.
        setRevealed((cur) => ({ ...cur, [asking]: { failed: true } })),
      )
      .finally(() => revealingRef.current.delete(asking))
  }, [onAnswer, answered, carried, index, chosen, revealed])

  function choose(optionIndex) {
    // A tap that opened a definition must not also count as an answer.
    if (!canChange || openTerm) return
    const next = [...answersRef.current]
    next[index] = optionIndex
    answersRef.current = next
    setAnswers(next)
    persist(index, next)
  }

  /** Move to a question. Every route between questions comes through here. */
  function goTo(to) {
    if (to < 0 || to >= questions.length || to === index) return
    setIndex(to)
    setVisited((seen) => new Set(seen).add(to))
    persist(to, answersRef.current)
  }

  /** Save where the learner is, with the deadline a timed run has to keep. */
  function persist(position, answerList) {
    attempt?.save?.({
      position,
      answers: answerList,
      state: deadlineRef.current
        ? { expires_at: new Date(deadlineRef.current).toISOString() }
        : {},
    })
  }

  async function next() {
    if (index < questions.length - 1) {
      goTo(index + 1)
      return
    }
    await finish(answers)
  }

  function restart() {
    setIndex(0)
    answersRef.current = questions.map(() => null)
    setAnswers(answersRef.current)
    setVisited(new Set([0]))
    setFinished(false)
    setResult(null)
    setTimedOut(false)
    setRemaining(durationMinutes * 60)
    setRevealed({})
    revealingRef.current = new Set()
    deadlineRef.current = null
    submittingRef.current = false
    // Starting over discards the saved run rather than resuming into it.
    attempt?.clear?.()
    onRestart?.()
  }

  // An exam has more to say at the end than a quiz does — a per-domain
  // breakdown against the real paper's weights — so it supplies its own screen.
  // A quiz keeps the plain one below, which is the right size for ten questions
  // on a single topic.
  if (finished && result && renderResult) {
    // Values only: `restart` closes over refs, and handing a function that
    // reads one to a render-time callback is exactly what the refs rule is
    // there to stop. A custom screen decides its own way out.
    return renderResult({ result, questions, timedOut })
  }

  if (finished && result) {
    const pct = Math.round(result.score)
    const good = pct >= 70
    return (
      <div className="card flex flex-col items-center gap-5 py-10 text-center">
        <div
          className={[
            'flex size-20 items-center justify-center rounded-full text-2xl font-bold text-white',
            good ? 'bg-success' : pct >= 40 ? 'bg-accent' : 'bg-warning',
          ].join(' ')}
        >
          {pct}%
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-pri">
            {result.correct} of {result.total} correct
          </h2>
          <p className="text-sm text-sec">
            {timedOut
              ? 'Time ran out — the paper was submitted as it stood.'
              : good
                ? 'Strong — you know this domain well.'
                : pct >= 40
                  ? 'Getting there. Worth another pass.'
                  : 'This one needs more review.'}
          </p>
        </div>
        <button onClick={restart} className="btn-primary">
          <RotateCcw size={16} aria-hidden="true" />
          Try again
        </button>

        {/* One list, every question, each tile carrying its own state. No
            split between flagged and missed: a question can be both, so
            sections would either duplicate it or have to pick one. */}
        {sessionResults.length > 0 && (
          <div className="w-full space-y-2 pt-2 text-left">
            <ResultsGrid results={sessionResults} />
          </div>
        )}
      </div>
    )
  }

  if (!q) return null

  const optionExplanations = answer.option_explanations || []
  const terms = q.terms || []
  // An acronym expands on the first occurrence a learner reads, counted across
  // the whole question rather than per line.
  const [questionExpand, ...optionExpand] = planExpansions(
    [q.question, ...q.options], terms,
  )
  // Under a tenth of the clock (or the last two minutes) counts as the run-in.
  const urgent =
    durationMinutes > 0 &&
    remaining <= Math.min(120, Math.round(durationMinutes * 60 * 0.1))

  return (
    <div className="space-y-5">
      {/* Progress */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-sec">
          <span className="inline-flex items-center gap-1">
            Question {index + 1} of {questions.length}
            {/* Always available, including on a question already answered
                correctly — the signal worth catching is the learner's own
                uncertainty, not the outcome. */}
            <FlagToggle
              flagged={flags.has(index)}
              onToggle={() => toggleFlag(index)}
              className="-my-2 size-9"
            />
          </span>
          {durationMinutes > 0 && (
            <span
              className={`inline-flex items-center gap-1 tabular-nums ${
                urgent ? 'font-semibold text-warning' : ''
              }`}
              aria-label={`${clock(remaining)} remaining`}
            >
              <Clock size={12} aria-hidden="true" />
              {clock(remaining)} left
            </span>
          )}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${((index + (answered ? 1 : 0)) / questions.length) * 100}%` }}
          />
        </div>
        <QuestionNavigator
          count={questions.length}
          index={index}
          answers={answers}
          visited={visited}
          onJump={goTo}
        />
      </div>

      {/* Keyed, so changing question remounts this and replays the entrance.
          Nothing waits for an exit: the next question is in the DOM the moment
          `index` changes. */}
      <div key={index} className="step-in space-y-4">
          <p className="text-lg font-medium text-pri">
            <TermText
              text={q.question}
              terms={terms}
              expand={questionExpand}
              onSelect={setOpenTerm}
            />
          </p>

          <div className="space-y-2.5">
            {q.options.map((option, i) => {
              const isChosen = chosen === i
              const isCorrect = correctIndex != null && i === correctIndex

              const why = optionExplanations[i]

              let tone = 'border-border bg-surface hover:border-accent/50'
              if (showState && isCorrect) {
                tone = 'border-success bg-success/10'
              } else if (showState && isChosen && !isCorrect) {
                tone = 'border-warning bg-warning/10'
              } else if (showState) {
                tone = 'border-border bg-surface opacity-60'
              } else if (isChosen) {
                // Chosen, with nothing yet said about whether it's right. Every
                // other branch here depends on the answer having been revealed,
                // so without this an exam — which reveals nothing until the end
                // — showed no sign of what you had picked, either as you picked
                // it or when you came back to check.
                tone = 'border-accent bg-accent/10'
              }

              return (
                <button
                  key={i}
                  onClick={() => choose(i)}
                  disabled={!canChange}
                  aria-pressed={isChosen}
                  className={`flex w-full flex-col gap-2 rounded-xl border px-4 py-3 text-left transition-colors ${tone}`}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={[
                        'flex size-7 shrink-0 items-center justify-center rounded-lg text-sm font-semibold',
                        showState && isCorrect
                          ? 'bg-success text-white'
                          : showState && isChosen
                            ? 'bg-warning text-white'
                            : 'bg-surface2 text-sec',
                      ].join(' ')}
                    >
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className="flex-1 text-sm text-pri">
                      <TermText
                        text={option}
                        terms={terms}
                        expand={optionExpand[i]}
                        onSelect={setOpenTerm}
                      />
                    </span>
                    {showState && isCorrect && (
                      <Check size={18} className="shrink-0 text-success" aria-hidden="true" />
                    )}
                    {showState && isChosen && !isCorrect && (
                      <X size={18} className="shrink-0 text-warning" aria-hidden="true" />
                    )}
                  </div>
                  {/* Every option explains itself once an answer is in — right
                      or wrong, chosen or not. */}
                  {showState && why && (
                    <p className="pl-10 text-xs leading-relaxed text-sec">{why}</p>
                  )}
                </button>
              )
            })}
          </div>

          {/* The overall rationale, once answered. Mounted plainly: an
              animated `initial` that never advances would leave the
              explanation invisible, and an explanation is the point. */}
          {isRevealed && explanation && (
            <div className="rounded-xl bg-surface2 px-4 py-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-accent2">
                {chosen === correctIndex ? 'Correct' : 'Explanation'}
              </p>
              <p className="text-sm leading-relaxed text-pri">{explanation}</p>
            </div>
          )}
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => goTo(index - 1)}
          disabled={index === 0}
          className="btn-secondary min-h-11 shrink-0 px-4 disabled:opacity-40"
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Previous
        </button>
        <button onClick={next} disabled={!answered} className="btn-primary flex-1">
          {index < questions.length - 1 ? 'Next question' : 'Finish & score'}
        </button>
      </div>

      <TermSheet term={openTerm} onClose={() => setOpenTerm(null)} />
    </div>
  )
}
