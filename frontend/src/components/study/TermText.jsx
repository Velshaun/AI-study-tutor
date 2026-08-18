import { segmentText } from '../../lib/terms'

/**
 * Study text with its key terms made tappable.
 *
 * Vocabulary gets a subtle accent underline so a learner can see there's more
 * to read; acronyms get the same treatment plus their expansion inline on first
 * occurrence — "GNU (GNU's Not Unix)" — because an unexpanded acronym is the
 * one thing a reader can't even look up.
 *
 * Terms are pre-generated with the question, so tapping opens the definition
 * instantly with nothing to fetch.
 *
 * `expand` is the set of acronyms (lower-cased) whose expansion belongs in this
 * particular block — see `planExpansions`, which decides that across a whole
 * question so it happens once, not once per option.
 */
export default function TermText({ text, terms, expand, onSelect, className = '' }) {
  const segments = segmentText(text, terms, expand)

  return (
    <span className={className}>
      {segments.map((segment, i) =>
        segment.term ? (
          <button
            key={i}
            type="button"
            onClick={(e) => {
              // These sit inside option buttons and flip-cards; opening a
              // definition must not also answer the question.
              e.preventDefault()
              e.stopPropagation()
              onSelect?.(segment.term)
            }}
            aria-label={`${segment.term.term} — show definition`}
            className="cursor-pointer rounded-sm underline decoration-accent decoration-2
                       underline-offset-4 transition-colors hover:text-accent2
                       focus-visible:outline-2 focus-visible:outline-offset-2
                       focus-visible:outline-accent"
          >
            {segment.text}
            {segment.expand && segment.term.expansion ? (
              <span className="font-normal"> ({segment.term.expansion})</span>
            ) : null}
          </button>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </span>
  )
}
