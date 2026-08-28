import { Check, Flag, Minus, X } from 'lucide-react'
import { useState } from 'react'

import { CORRECT, UNANSWERED, stateOf } from '../../lib/session'

/**
 * Every question of a finished sitting, in one scrolling list.
 *
 * Deliberately not split into "flagged" and "missed" sections. A question can
 * be both, so sections either duplicate it or pick one — and the thing a
 * learner is actually doing here is going down the list. So: one order, and
 * each tile carries its own state. Green for right, red for wrong, and a small
 * flag in the corner if it was flagged, whichever way it went.
 *
 * `locked` renders the same tiles without the expand affordance, for practice
 * mode — whose answers were posted as they were given and cannot be revisited
 * as a set. Same visual language, different contract, which is the distinction
 * the runners already draw everywhere else.
 */
export default function ResultsGrid({ results = [], locked = false }) {
  if (!results.length) return null

  return (
    <ul className="space-y-2">
      {results.map((result) => (
        <ResultTile key={result.index} result={result} locked={locked} />
      ))}
    </ul>
  )
}

const TONE = {
  [CORRECT]: {
    ring: 'border-success/40 bg-success/5',
    chip: 'bg-success/15 text-success',
    Icon: Check,
  },
  [UNANSWERED]: {
    ring: 'border-border bg-surface',
    chip: 'bg-surface2 text-sec',
    Icon: Minus,
  },
  wrong: {
    ring: 'border-warning/40 bg-warning/5',
    chip: 'bg-warning/15 text-warning',
    Icon: X,
  },
}

function ResultTile({ result, locked }) {
  const [open, setOpen] = useState(false)
  const state = stateOf(result)
  const tone = TONE[state] || TONE.wrong
  const { Icon } = tone

  const body = (
    <>
      <span className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${tone.chip}`}>
        <Icon size={14} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] uppercase tracking-wider text-sec">
          Question {result.index + 1}
        </span>
        <span className="block truncate text-sm text-pri">{result.prompt}</span>
      </span>
    </>
  )

  return (
    <li className={`relative overflow-hidden rounded-xl border ${tone.ring}`}>
      {/* The flag sits in the corner rather than in the row, so it reads at a
          glance while scrolling and never competes with the outcome. */}
      {result.flagged && (
        <span
          className="pointer-events-none absolute right-2 top-2 text-warning"
          title="You flagged this"
        >
          <Flag size={13} fill="currentColor" aria-hidden="true" />
          <span className="sr-only">Flagged</span>
        </span>
      )}

      {locked ? (
        <div className="flex items-center gap-3 px-3 py-3 pr-8">{body}</div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-3 px-3 py-3 pr-8 text-left"
        >
          {body}
        </button>
      )}

      {open && !locked && <Detail result={result} />}
    </li>
  )
}

/** What was chosen, what was right, and why — the part worth reading. */
function Detail({ result }) {
  const options = result.options || []
  const textOf = (option) =>
    typeof option === 'string' ? option : option?.text ?? ''

  return (
    <div className="space-y-2 border-t border-border/60 px-3 py-3">
      <p className="text-sm leading-relaxed text-pri">{result.prompt}</p>

      <ul className="space-y-1">
        {options.map((option, i) => {
          // Kind-aware: a multi-select answer is a set, so membership decides
          // both markers; mcq keeps its single index.
          const picked = Array.isArray(result.chosen)
            ? result.chosen
            : result.chosen_index != null ? [result.chosen_index] : []
          const rightSet = (result.correct_indices?.length
            ? result.correct_indices
            : result.correct_index != null ? [result.correct_index] : [])
          const chosen = picked.includes(i)
          const right = rightSet.includes(i)
          return (
            <li
              key={i}
              className={`flex items-start gap-1.5 text-xs ${
                right ? 'text-success' : chosen ? 'text-warning' : 'text-sec'
              }`}
            >
              <span className="mt-0.5 shrink-0">
                {right ? <Check size={12} aria-hidden="true" />
                  : chosen ? <X size={12} aria-hidden="true" />
                    : <span className="inline-block size-3" />}
              </span>
              <span>
                {textOf(option)}
                {chosen && !right && (
                  <span className="ml-1 text-[11px] text-sec">— you chose this</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {/* The typed kinds have no options to walk — show the exchange. */}
      {(result.kind === 'short' || result.kind === 'blank') && (
        <p className="text-xs text-pri">
          You answered: <span className="font-medium">
            {typeof result.chosen === 'string' && result.chosen.trim()
              ? result.chosen : '—'}
          </span>
          {!result.correct && (result.accepted || []).length > 0 && (
            <span className="text-sec"> · accepted: {result.accepted.join(' · ')}</span>
          )}
        </p>
      )}
      {!result.answered && (
        <p className="text-xs text-sec">You didn&rsquo;t answer this one.</p>
      )}
      {result.explanation && (
        <p className="text-xs leading-relaxed text-sec">{result.explanation}</p>
      )}
    </div>
  )
}
