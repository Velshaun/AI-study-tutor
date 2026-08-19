import { Check, RotateCcw, Sparkles, X } from 'lucide-react'
import { useState } from 'react'

/**
 * What a practice exam actually told you.
 *
 * The old score screen was a percentage in a circle and a "try again" button,
 * which is the one thing a learner cannot act on: a paper is 90 questions
 * across five domains, and "68%" says nothing about which of the five to open
 * next. That was not a display choice so much as a consequence — the grader
 * threw the domain attribution away, so 68% really was all the app knew.
 *
 * Now it knows more, so this shows it: the result against the real pass mark,
 * every domain with what it is worth on the paper, the written read, and the
 * questions that went wrong. In that order, because "did I pass" is the
 * question being asked and everything after it is why.
 */

const BANDS = [
  { at: 75, bar: 'bg-success', text: 'text-success' },
  { at: 50, bar: 'bg-warning', text: 'text-warning' },
  { at: 0, bar: 'bg-danger', text: 'text-danger' },
]

function band(pct) {
  return BANDS.find((b) => pct >= b.at) || BANDS[BANDS.length - 1]
}

export default function ExamSummary({ result, questions = [], onRestart }) {
  const [showMissed, setShowMissed] = useState(false)
  const pct = Math.round(result?.score ?? 0)
  const summary = result?.summary || {}
  const domains = result?.domains || []
  const missed = (result?.results || []).filter((r) => !r.is_correct)
  const isBaseline = result?.kind === 'pre_assessment'

  return (
    <div className="space-y-4">
      {/* The headline: the score, and whether it clears the real bar. */}
      <div className="card space-y-4 text-center">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-sec">
            {isBaseline ? 'Baseline assessment' : 'Practice exam'}
          </p>
          <p className={`text-4xl font-bold tabular-nums ${band(pct).text}`}>{pct}%</p>
          <p className="text-sm text-pri">
            {result.correct} of {result.total} correct
          </p>
        </div>

        {result.pass_pct != null && (
          <div className="space-y-1.5">
            <div className="relative h-2 overflow-hidden rounded-full bg-surface2">
              <div
                className={`h-full rounded-full ${band(pct).bar}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
              {/* The real threshold, drawn where it actually falls. */}
              <span
                className="absolute inset-y-0 w-0.5 bg-pri/60"
                style={{ left: `${Math.min(100, result.pass_pct)}%` }}
                aria-hidden="true"
              />
            </div>
            <p className="text-xs text-sec">
              {result.passed
                ? `Above the ${Math.round(result.pass_pct)}% pass mark`
                : `${Math.round(result.pass_pct)}% is the pass mark — ${
                    Math.max(0, Math.ceil(((result.pass_pct - pct) / 100) * result.total))
                  } more questions would do it`}
            </p>
          </div>
        )}

        {summary.verdict && (
          <p className="text-left text-sm leading-relaxed text-pri">{summary.verdict}</p>
        )}
      </div>

      {/* Per domain — with what each is worth on the real paper, because that is
          what turns a list of scores into an order of work. */}
      {domains.length > 0 && (
        <div className="card space-y-3">
          <Label>By domain</Label>
          <div className="space-y-2.5">
            {domains.map((d) => {
              const dp = Math.round(d.pct)
              return (
                <div key={d.domain_id || d.title} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm text-pri">{d.title}</p>
                    <p className="shrink-0 text-xs tabular-nums text-sec">
                      {d.correct} of {d.total}
                      {d.weight_pct ? ` · ${Math.round(d.weight_pct)}% of exam` : ''}
                    </p>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
                    <div
                      className={`h-full rounded-full ${band(dp).bar}`}
                      style={{ width: `${Math.min(100, dp)}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {summary.strengths?.length > 0 && (
        <Card label="What's holding up">
          {summary.strengths.map((s) => (
            <li key={s} className="text-sm text-pri">{s}</li>
          ))}
        </Card>
      )}

      {summary.gaps?.length > 0 && (
        <Card label="Where the marks went">
          {summary.gaps.map((g) => (
            <li key={g} className="text-sm text-pri">{g}</li>
          ))}
        </Card>
      )}

      {summary.next_steps?.length > 0 && (
        <div className="card space-y-2">
          <Label>
            <Sparkles size={12} className="inline" aria-hidden="true" /> Do this next
          </Label>
          <ol className="list-decimal space-y-1.5 pl-5 marker:text-accent2">
            {summary.next_steps.map((n) => (
              <li key={n} className="text-sm text-pri">{n}</li>
            ))}
          </ol>
        </div>
      )}

      {missed.length > 0 && (
        <div className="card space-y-3">
          <button
            onClick={() => setShowMissed((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <Label>
              {missed.length} question{missed.length === 1 ? '' : 's'} to review
            </Label>
            <span className="text-xs font-medium text-accent2">
              {showMissed ? 'Hide' : 'Show'}
            </span>
          </button>

          {showMissed && (
            <div className="space-y-4">
              {missed.map((r) => {
                const q = questions[r.index]
                if (!q) return null
                return (
                  <div key={r.index} className="space-y-1.5 border-t border-border pt-3">
                    <p className="text-sm text-pri">{q.question}</p>
                    <div className="space-y-1">
                      {r.chosen_index != null && (
                        <p className="flex items-start gap-1.5 text-xs text-warning">
                          <X size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                          You chose: {q.options?.[r.chosen_index]}
                        </p>
                      )}
                      <p className="flex items-start gap-1.5 text-xs text-success">
                        <Check size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        {q.options?.[r.correct_index]}
                      </p>
                    </div>
                    {r.explanation && (
                      <p className="text-xs leading-relaxed text-sec">{r.explanation}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {onRestart && (
        <button onClick={onRestart} className="btn-secondary w-full">
          <RotateCcw size={16} aria-hidden="true" />
          Back to the module
        </button>
      )}
    </div>
  )
}

function Label({ children }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wider text-sec">{children}</p>
  )
}

function Card({ label, children }) {
  return (
    <div className="card space-y-2">
      <Label>{label}</Label>
      <ul className="list-disc space-y-1.5 pl-5 marker:text-accent2">{children}</ul>
    </div>
  )
}
