import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../lib/api'
import ResultsGrid from '../study/ResultsGrid'
import PreAssessmentCard from './PreAssessmentCard'

/**
 * The pre-assessment, and what has changed since.
 *
 * Its own section, separate from practice exams, because it is not one of them:
 * it is the line everything else is measured against, and a module gets exactly
 * one — enforced by a unique index, since a second would silently move that
 * line.
 *
 * Once taken, the offer to take one never appears again and the sitting becomes
 * a permanent record: every question, what was answered, what was right. Taking
 * it is optional, so a module without one is not a module with a problem, and
 * this section says nothing about missing baselines until there is something to
 * say.
 */
export default function BaselineSection({ moduleId, questionCount, canTake }) {
  const [open, setOpen] = useState(false)

  const { data, isPending } = useQuery({
    queryKey: ['baseline', moduleId],
    queryFn: ({ signal }) => api.baselineComparison(moduleId, signal),
    enabled: Boolean(moduleId),
  })

  // No baseline yet: the offer, but only while there is material to assess.
  if (!isPending && !data) {
    return canTake
      ? <PreAssessmentCard moduleId={moduleId} questionCount={questionCount} />
      : null
  }
  if (isPending || !data) return null

  const { baseline, latest, delta, domains = [] } = data
  const results = baseline?.results || []

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 border-l-2 border-accent pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
        Where you started
      </h2>

      <div className="card space-y-3">
        <div className="flex items-center gap-4">
          <Score label="Baseline" pct={Math.round(baseline?.score ?? 0)} />
          {latest ? (
            <>
              <Delta value={delta} />
              <Score label="Latest" pct={Math.round(latest.score ?? 0)} strong />
            </>
          ) : (
            <p className="flex-1 text-xs leading-relaxed text-sec">
              Sit a practice exam and this becomes a comparison.
            </p>
          )}
        </div>

        {/* Per domain, biggest gain first — the order that answers "is the work
            paying off", which is the question this section exists for. */}
        {domains.length > 0 && latest && (
          <ul className="space-y-1 border-t border-border pt-2">
            {domains.map((d) => (
              <li key={d.domain_id || d.title}
                  className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-sec">{d.title}</span>
                <span className="shrink-0 tabular-nums text-sec">
                  {d.then == null ? '—' : `${Math.round(d.then)}%`}
                </span>
                <span className="shrink-0 text-sec">→</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-pri">
                  {d.now == null ? '—' : `${Math.round(d.now)}%`}
                </span>
                <span
                  className={`w-12 shrink-0 text-right tabular-nums ${
                    d.delta == null ? 'text-sec'
                      : d.delta > 0 ? 'text-success'
                        : d.delta < 0 ? 'text-warning' : 'text-sec'
                  }`}
                >
                  {d.delta == null ? '' : d.delta > 0 ? `+${Math.round(d.delta)}` : Math.round(d.delta)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {results.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex min-h-9 w-full items-center justify-between border-t border-border pt-2 text-xs text-accent2"
            >
              <span>{open ? 'Hide' : 'Show'} the baseline paper</span>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`transition-transform ${open ? 'rotate-180' : ''}`}
              />
            </button>
            {open && <ResultsGrid results={results} locked />}
          </>
        )}
      </div>
    </section>
  )
}

function Score({ label, pct, strong = false }) {
  return (
    <div className="text-center">
      <div
        className={`flex size-14 items-center justify-center rounded-full text-sm font-bold ${
          strong ? 'bg-accent text-white' : 'bg-surface2 text-sec'
        }`}
      >
        {pct}%
      </div>
      <p className="pt-1 text-[11px] text-sec">{label}</p>
    </div>
  )
}

function Delta({ value }) {
  const up = (value ?? 0) > 0
  const flat = !value
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown
  return (
    <div className={`flex flex-1 flex-col items-center ${
      flat ? 'text-sec' : up ? 'text-success' : 'text-warning'
    }`}>
      <Icon size={18} aria-hidden="true" />
      <span className="text-xs font-medium tabular-nums">
        {flat ? 'no change' : `${up ? '+' : ''}${Math.round(value)} points`}
      </span>
    </div>
  )
}
