import { useQuery } from '@tanstack/react-query'
import { ChevronDown, GraduationCap } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../lib/api'
import { STATUS, displayScore, sessionLabel, statusOf } from '../../lib/performance'
import SectionHeading from './SectionHeading'

/**
 * Learner readiness — how is this learner performing, domain by domain?
 *
 * A property of the learner, not of the sources. It moves when an exam or quiz
 * is graded and never when material is added. The action it points at is "go
 * and study", which is the opposite of what its sibling card asks for.
 *
 * These were one number until this change, blending quiz scores with lecture
 * progress and with *questions answered out of questions generated*. That last
 * term is the bug: generating more practice from newly added sources raised the
 * denominator and dropped the learner's score without them doing anything. A
 * number that falls when you add material is not a measure of the learner.
 *
 * The per-domain detail lives in the domain rows above; this is the summary and
 * the order of work.
 */

const COLLAPSE_KEY = 'learner-readiness-collapsed'

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
    /* a browser refusing storage costs the memory of the choice, nothing more */
  }
}

export default function LearnerReadinessCard({ moduleId }) {
  const [collapsed, setCollapsed] = useState(() => storedCollapsed(moduleId))
  const { data, isPending } = useQuery({
    queryKey: ['performance', moduleId],
    queryFn: ({ signal }) => api.performance(moduleId, signal),
  })

  if (isPending) return <div className="skeleton h-32 rounded-2xl" />
  if (!data?.available) return null

  const domains = data.domains || []
  if (!domains.length) return null
  const graded = domains.filter((d) => d.attempts > 0)

  function toggle() {
    const next = !collapsed
    setCollapsed(next)
    rememberCollapsed(moduleId, next)
  }

  return (
    <section className="space-y-3">
      <SectionHeading Icon={GraduationCap} tone="success">How you&rsquo;re doing</SectionHeading>
      <p className="px-1 text-xs text-sec">
        Your performance across {data.attempts} sitting{data.attempts === 1 ? '' : 's'}.
        Adding material won&rsquo;t change this.
      </p>

      <div className="card space-y-4">
        <button
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-4 text-left"
        >
          <span className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-success/40">
            <span className="text-lg font-bold tabular-nums text-pri">
              {data.overall == null ? '—' : `${Math.round(data.overall)}%`}
            </span>
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block text-sm font-medium text-pri">
              {data.overall == null
                ? 'Nothing graded yet'
                : 'Weighted across the exam blueprint'}
            </span>
            <span className="block text-xs text-sec">
              {graded.length === 0
                ? 'Sit a practice exam to start measuring this.'
                : data.focus.length
                  ? `Weakest first: ${data.focus.slice(0, 2).join(', ')}`
                  : 'Every domain you’ve been tested on is holding up.'}
            </span>
          </span>
          <ChevronDown
            size={18}
            className={`shrink-0 text-sec transition-transform ${collapsed ? '' : 'rotate-180'}`}
            aria-hidden="true"
          />
        </button>

        {!collapsed && graded.length > 0 && (
          <div className="space-y-2.5">
            {graded.map((d) => {
              const tone = statusOf(d)
              const session = sessionLabel(d)
              return (
                <div key={d.domain_id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm text-pri">{d.title}</p>
                    <span className={`shrink-0 text-xs font-medium ${tone.text}`}>
                      {displayScore(d)}
                      {d.weight_pct ? ` · ${Math.round(d.weight_pct)}%` : ''}
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-surface2">
                    <div
                      className={`h-full rounded-full ${tone.bar}`}
                      style={{ width: `${Math.min(100, d.display ?? 0)}%` }}
                    />
                  </div>
                  {/* Today's result sits under the rolling one, never replacing
                      it — a bad session should be visible without being the
                      headline. */}
                  <p className="text-[11px] text-sec">
                    {session ? `${Math.round(d.session)}% ${session}` : STATUS[d.status].label}
                    {d.note ? ` — ${d.note}` : ''}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
