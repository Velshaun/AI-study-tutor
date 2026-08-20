import { useEffect, useRef } from 'react'

/**
 * The paper at a glance: one circle per question, tap to jump.
 *
 * On a 90-question exam the thing a learner most wants to know is which ones
 * they have left, and the only way to find out was to walk forward through all
 * of them. Three states answer it without reading anything: filled means
 * answered, an outline means you are here, and an empty circle means you have
 * not been yet.
 *
 * Jumping is just `setIndex`, so it needs nothing the runner didn't already
 * have — the keyed mount that replaced `AnimatePresence` renders whichever
 * index it is given, in any order, with no transition to wait on.
 */
export default function QuestionNavigator({
  count, index, answers, visited, onJump, canJump, locked = false,
}) {
  const activeRef = useRef(null)

  // Keep the current question in view as the run moves, including when Next
  // walks past the right-hand edge. `auto` rather than `smooth`: a scroll that
  // depends on frames arriving is the same mistake as a step that does, and
  // there is nothing to watch here anyway.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [index])

  if (count < 2) return null

  return (
    <nav
      aria-label="Questions"
      className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
    >
      {Array.from({ length: count }, (_, i) => {
        const isCurrent = i === index
        const isAnswered = answers[i] != null
        const seen = visited.has(i)
        // Not every answered question can be returned to. Practice mode records
        // each answer as it is given and keeps nothing client-side, so after a
        // resume there is genuinely nothing to show for the ones answered
        // before — better to refuse the jump than to reopen a question as if it
        // were unanswered.
        const reachable = isCurrent || (canJump ? canJump(i) : true)

        // Current wins over answered, which wins over merely seen: the outline
        // is the "you are here" marker and has to survive being answered.
        const tone = isCurrent
          ? 'border-accent text-accent2 bg-transparent'
          : isAnswered
            ? 'border-accent bg-accent text-white'
            : seen
              ? 'border-border bg-surface2 text-sec'
              : 'border-border bg-transparent text-sec'

        return (
          <button
            key={i}
            ref={isCurrent ? activeRef : null}
            onClick={() => onJump(i)}
            disabled={!reachable}
            aria-label={`Question ${i + 1}${
              isAnswered ? ', answered' : seen ? ', visited' : ', not visited'
            }${locked && isAnswered && !isCurrent ? ', locked' : ''}${
              reachable ? '' : ', not available'
            }`}
            aria-current={isCurrent ? 'true' : undefined}
            className={`flex size-8 shrink-0 items-center justify-center rounded-full border-2
                        text-xs font-semibold tabular-nums transition-colors ${tone}
                        ${reachable ? '' : 'cursor-default opacity-40'}`}
          >
            {i + 1}
          </button>
        )
      })}
    </nav>
  )
}
