import { Loader2, Sparkles } from 'lucide-react'
import { useState } from 'react'

import { usePreferences } from '../../hooks/usePreferences'

/**
 * The "generate study material" form, shared by flashcards and quizzes.
 *
 * Difficulty is pre-filled from the learner's saved preference (§5.3) and
 * overridable here, exactly as the spec asks — the backend applies the same
 * default when the field is omitted, so this is purely a convenience surface.
 */
const DIFFICULTIES = ['easy', 'medium', 'hard']

export default function GenerateForm({
  kind, // 'flashcards' | 'quiz'
  onGenerate,
  generating,
  error,
}) {
  const { preferences } = usePreferences()
  const prefKey = kind === 'quiz' ? 'quiz_difficulty' : 'flashcard_difficulty'

  const [difficulty, setDifficulty] = useState(preferences[prefKey] || 'medium')
  const [count, setCount] = useState(kind === 'quiz' ? 5 : 10)

  const label = kind === 'quiz' ? 'questions' : 'cards'
  const max = kind === 'quiz' ? 20 : 30

  return (
    <div className="card space-y-5">
      <div className="flex items-center gap-2">
        <Sparkles size={18} className="text-accent" aria-hidden="true" />
        <h2 className="text-base font-semibold text-pri">
          Generate {kind === 'quiz' ? 'a quiz' : 'flashcards'}
        </h2>
      </div>

      {/* Difficulty */}
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium uppercase tracking-wider text-sec">
          Difficulty
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {DIFFICULTIES.map((d) => (
            <label
              key={d}
              className={[
                'cursor-pointer rounded-xl border px-3 py-2 text-center text-sm',
                'capitalize transition-colors',
                difficulty === d
                  ? 'border-accent bg-surface2 text-accent2'
                  : 'border-border text-sec hover:text-pri',
              ].join(' ')}
            >
              <input
                type="radio"
                name="difficulty"
                value={d}
                checked={difficulty === d}
                onChange={() => setDifficulty(d)}
                className="sr-only"
              />
              {d}
              {preferences[prefKey] === d && (
                <span className="ml-1 text-[10px] text-sec">· default</span>
              )}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Count */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label htmlFor="count" className="text-xs font-medium uppercase tracking-wider text-sec">
            How many {label}
          </label>
          <span className="text-sm font-medium tabular-nums text-pri">{count}</span>
        </div>
        <input
          id="count"
          type="range"
          min={kind === 'quiz' ? 3 : 5}
          max={max}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface2 accent-accent"
        />
      </div>

      {error && <p className="text-sm text-warning">{error}</p>}

      <button
        onClick={() => onGenerate({ difficulty, count })}
        disabled={generating}
        className="btn-primary w-full"
      >
        {generating ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            Generating…
          </>
        ) : (
          <>
            <Sparkles size={16} aria-hidden="true" />
            Generate {count} {label}
          </>
        )}
      </button>
    </div>
  )
}
