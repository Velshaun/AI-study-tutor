import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Target } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../lib/api'

/**
 * Exam readiness, domain by domain.
 *
 * Built from what the app already records — quiz scores, lecture progress,
 * practice answered, questions flagged for review — and weighted by each
 * domain's share of the paper, because being shaky on 32% of the exam is not
 * the same as being shaky on 4%.
 *
 * A domain nothing has been attempted in shows a dash rather than a zero: an
 * untouched domain isn't a failed one, and saying "0%" would read as though the
 * learner had tried and got everything wrong.
 *
 * It collapses, and it sits below the domain list. This is a summary of the
 * screen above it: the domains are what a learner navigates by, and a full
 * per-domain breakdown standing between them and their topics made the page
 * something to scroll past. Collapsed, the headline number stays — hiding the
 * detail shouldn't mean hiding where you stand — and the choice is remembered
 * per module, because "I've seen this" is a lasting statement, not a per-visit
 * one.
 */

const COLLAPSE_KEY = 'readiness-collapsed'

function storedCollapsed(moduleId) {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}')[moduleId] === true
  } catch {
    return false
  }
}

function rememberCollapsed(moduleId, collapsed) {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}')
    all[moduleId] = collapsed
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(all))
  } catch {
    // A browser refusing storage costs the memory of the choice, nothing more.
  }
}

const STATUS = {
  strong: { label: 'Strong', dot: 'bg-success', text: 'text-success' },
  developing: { label: 'Developing', dot: 'bg-accent', text: 'text-accent2' },
  weak: { label: 'Needs work', dot: 'bg-warning', text: 'text-warning' },
  untouched: { label: 'Not started', dot: 'bg-border', text: 'text-sec' },
}

export default function ReadinessCard({ moduleId }) {
  const [collapsed, setCollapsed] = useState(() => storedCollapsed(moduleId))
  const { data, isPending } = useQuery({
    queryKey: ['readiness', moduleId],
    queryFn: ({ signal }) => api.readiness(moduleId, signal),
  })

  if (isPending) return <div className="skeleton h-40 rounded-2xl" />

  const domains = data?.domains || []
  if (!domains.length) return null

  const overall = data?.overall
  const focus = data?.focus || []

  function toggle() {
    const next = !collapsed
    setCollapsed(next)
    rememberCollapsed(moduleId, next)
  }

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 border-l-2 border-accent pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
        <Target size={13} aria-hidden="true" />
        Exam readiness
      </h2>

      <div className="card space-y-4">
        {/* The headline stays whether or not the detail is open — collapsing is
            for hiding the working, not the answer. */}
        <button
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-4 text-left"
        >
          <span className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-accent/40">
            <span className="text-lg font-bold tabular-nums text-pri">
              {overall == null ? '—' : `${Math.round(overall)}%`}
            </span>
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block text-sm font-medium text-pri">
              {overall == null
                ? 'Nothing attempted yet'
                : 'Weighted across the exam blueprint'}
            </span>
            <span className="block text-xs text-sec">
              {data?.untouched_weight_pct > 0
                ? `${Math.round(data.untouched_weight_pct)}% of the exam is still untouched`
                : 'Every domain has been started'}
            </span>
          </span>
          <ChevronDown
            size={18}
            className={`shrink-0 text-sec transition-transform ${
              collapsed ? '' : 'rotate-180'
            }`}
            aria-hidden="true"
          />
        </button>

        {collapsed ? null : (
        <div className="space-y-2.5">
          {domains.map((d) => {
            const tone = STATUS[d.status] || STATUS.untouched
            return (
              <div key={d.domain_id} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className={`size-2 shrink-0 rounded-full ${tone.dot}`}
                      aria-hidden="true"
                    />
                    <span className="truncate text-sm text-pri">{d.title}</span>
                  </p>
                  <span className={`shrink-0 text-xs font-medium ${tone.text}`}>
                    {d.score == null ? tone.label : `${Math.round(d.score)}%`}
                    {d.weight_pct ? ` · ${Math.round(d.weight_pct)}%` : ''}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-surface2">
                  <div
                    className={`h-full rounded-full transition-[width] duration-500 ${tone.dot}`}
                    style={{ width: `${d.score == null ? 0 : Math.min(100, d.score)}%` }}
                  />
                </div>
                {/* The evidence behind the number, so it isn't a black box. */}
                <p className="text-[11px] text-sec">
                  {[
                    d.quizzes_taken
                      ? `${d.quizzes_taken} quiz${d.quizzes_taken === 1 ? '' : 'zes'} · ${Math.round(d.quiz_average)}%`
                      : null,
                    d.practice_total
                      ? `${d.practice_answered}/${d.practice_total} practice`
                      : null,
                    d.lecture_progress_pct
                      ? `${Math.round(d.lecture_progress_pct)}% of lecture`
                      : null,
                    d.flagged_for_review
                      ? `${d.flagged_for_review} flagged`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'No study recorded yet'}
                </p>
              </div>
            )
          })}
        </div>
        )}

        {!collapsed && focus.length > 0 && (
          <div className="rounded-xl bg-accent/10 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent2">
              Study these next
            </p>
            <p className="mt-1 text-sm text-pri">{focus.join(' · ')}</p>
          </div>
        )}
      </div>
    </section>
  )
}
