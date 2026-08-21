import { Flag } from 'lucide-react'

/**
 * "I'm not sure about this one" — during a run, on any question.
 *
 * Independent of whether the answer turns out to be right: the useful signal is
 * the learner's own uncertainty, and a lucky guess is exactly the case worth
 * catching. So this is never derived from the outcome and never cleared by one.
 *
 * Distinct from the older Review Later flag, which wrote to the server the
 * moment it was pressed. This is session state until the confirmation prompt at
 * the end, so flagging costs nothing and can be undone by simply not
 * confirming.
 */
export default function FlagToggle({ flagged, onToggle, className = '' }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={flagged}
      aria-label={flagged ? 'Remove flag' : 'Flag this question'}
      title={flagged ? 'Flagged — tap to unflag' : 'Flag if you were unsure'}
      className={`flex size-11 shrink-0 items-center justify-center rounded-full
                  transition-colors ${
                    flagged ? 'text-warning' : 'text-sec hover:text-pri'
                  } ${className}`}
    >
      <Flag
        size={17}
        fill={flagged ? 'currentColor' : 'none'}
        aria-hidden="true"
      />
    </button>
  )
}
