import { AnimatePresence, motion } from 'framer-motion'
import { Check, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'

/**
 * Quiz runner — spec Prompt 6.6.
 *
 * One question at a time, four options. Selecting an option locks it in and
 * reveals immediate correct/incorrect feedback plus the explanation; the
 * correct option is highlighted whether or not it was chosen. A score screen
 * closes the run.
 *
 * The correct answers ship with the quiz (it's a study quiz, not a proctored
 * exam), so feedback is instant with no round-trip. The full set of answers is
 * still submitted at the end for an authoritative, recorded score.
 */
export default function QuizRunner({ quiz, onSubmit, onRestart }) {
  const questions = quiz.questions || []
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState(() => questions.map(() => null))
  const [locked, setLocked] = useState(false)
  const [finished, setFinished] = useState(false)
  const [result, setResult] = useState(null)

  const q = questions[index]
  const chosen = answers[index]

  function choose(optionIndex) {
    if (locked) return
    setAnswers((prev) => {
      const next = [...prev]
      next[index] = optionIndex
      return next
    })
    setLocked(true)
  }

  async function next() {
    if (index < questions.length - 1) {
      setIndex((i) => i + 1)
      setLocked(answers[index + 1] != null)
      return
    }
    // Last question — submit for the authoritative score.
    const res = await onSubmit(answers)
    setResult(res)
    setFinished(true)
  }

  function restart() {
    setIndex(0)
    setAnswers(questions.map(() => null))
    setLocked(false)
    setFinished(false)
    setResult(null)
    onRestart?.()
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
            {good
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
      </div>
    )
  }

  if (!q) return null

  return (
    <div className="space-y-5">
      {/* Progress */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-sec">
          <span>
            Question {index + 1} of {questions.length}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${((index + (locked ? 1 : 0)) / questions.length) * 100}%` }}
          />
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={index}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.2 }}
          className="space-y-4"
        >
          <p className="text-lg font-medium text-pri">{q.question}</p>

          <div className="space-y-2.5">
            {q.options.map((option, i) => {
              const isChosen = chosen === i
              const isCorrect = i === q.correct_index
              const showState = locked

              let tone = 'border-border bg-surface hover:border-accent/50'
              if (showState && isCorrect) {
                tone = 'border-success bg-success/10'
              } else if (showState && isChosen && !isCorrect) {
                tone = 'border-warning bg-warning/10'
              } else if (showState) {
                tone = 'border-border bg-surface opacity-60'
              }

              return (
                <button
                  key={i}
                  onClick={() => choose(i)}
                  disabled={locked}
                  className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${tone}`}
                >
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
                  <span className="flex-1 text-sm text-pri">{option}</span>
                  {showState && isCorrect && (
                    <Check size={18} className="shrink-0 text-success" aria-hidden="true" />
                  )}
                  {showState && isChosen && !isCorrect && (
                    <X size={18} className="shrink-0 text-warning" aria-hidden="true" />
                  )}
                </button>
              )
            })}
          </div>

          {/* Explanation, once answered */}
          {locked && q.explanation && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="rounded-xl bg-surface2 px-4 py-3"
            >
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-accent2">
                {chosen === q.correct_index ? 'Correct' : 'Explanation'}
              </p>
              <p className="text-sm leading-relaxed text-pri">{q.explanation}</p>
            </motion.div>
          )}
        </motion.div>
      </AnimatePresence>

      <button onClick={next} disabled={!locked} className="btn-primary w-full">
        {index < questions.length - 1 ? 'Next question' : 'Finish & score'}
      </button>
    </div>
  )
}
