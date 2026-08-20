import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Library, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../lib/api'

/**
 * Content readiness — does the app hold enough material to teach this exam?
 *
 * A property of the sources, not of the learner. It moves when material is
 * added or removed and never when an exam is sat. The action it points at is
 * "go and find more material", which is why it lives in its own card with its
 * own language: this number going up is a job for the library, not the desk.
 *
 * Its sibling, LearnerReadinessCard, answers the opposite question from the
 * opposite evidence. They are deliberately never shown side by side and never
 * added together — the score that used to do both moved when either input
 * changed, which made it useless for deciding what to do next.
 */

const COVERAGE = {
  well_covered: { label: 'Covered', bar: 'bg-success', text: 'text-success' },
  partial: { label: 'Thin', bar: 'bg-warning', text: 'text-warning' },
  missing: { label: 'Nothing yet', bar: 'bg-danger', text: 'text-danger' },
}

const DEPTH_COPY = {
  thorough: 'taught in depth',
  overview: 'explained briefly',
  mention: 'only mentioned',
}

const COLLAPSE_KEY = 'content-readiness-collapsed'

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

export default function ContentReadinessCard({ moduleId }) {
  const [collapsed, setCollapsed] = useState(() => storedCollapsed(moduleId))
  const { data, isPending } = useQuery({
    queryKey: ['coverage', moduleId],
    queryFn: ({ signal }) => api.coverage(moduleId, signal),
  })

  if (isPending) return <div className="skeleton h-32 rounded-2xl" />
  if (!data?.available) return null

  const domains = data.domains || []
  const building = data.status === 'computing'

  function toggle() {
    const next = !collapsed
    setCollapsed(next)
    rememberCollapsed(moduleId, next)
  }

  // Weakest first: the answer to "what should I go and find" in order.
  const gaps = [...domains]
    .filter((d) => d.coverage !== 'well_covered')
    .sort((a, b) => (b.weight_pct || 0) - (a.weight_pct || 0))

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 border-l-2 border-accent2 pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
        <Library size={13} aria-hidden="true" />
        Your material
      </h2>
      <p className="px-1 text-xs text-sec">
        How much of the exam your uploaded sources can actually teach.
      </p>

      <div className="card space-y-4">
        <button
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-4 text-left"
        >
          <span className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-accent2/40">
            {building ? (
              <Loader2 size={20} className="animate-spin text-accent2" aria-hidden="true" />
            ) : (
              <span className="text-lg font-bold tabular-nums text-pri">
                {data.covered_pct == null ? '—' : `${Math.round(data.covered_pct)}%`}
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block text-sm font-medium text-pri">
              {building
                ? 'Reading your sources…'
                : data.covered_pct == null
                  ? 'No material read yet'
                  : gaps.length === 0
                    ? 'Your sources cover the whole blueprint'
                    : `${gaps.length} domain${gaps.length === 1 ? '' : 's'} need more material`}
            </span>
            <span className="block text-xs text-sec">
              {data.truncated
                ? 'Your pack was too large to read in one pass — some of it wasn’t indexed.'
                : 'Add sources to raise this. Studying won’t change it.'}
            </span>
          </span>
          <ChevronDown
            size={18}
            className={`shrink-0 text-sec transition-transform ${collapsed ? '' : 'rotate-180'}`}
            aria-hidden="true"
          />
        </button>

        {!collapsed && domains.length > 0 && (
          <div className="space-y-2.5">
            {domains.map((d) => {
              const tone = COVERAGE[d.coverage] || COVERAGE.partial
              return (
                <div key={d.domain_id || d.title} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm text-pri">{d.title}</p>
                    <span className={`shrink-0 text-xs font-medium ${tone.text}`}>
                      {tone.label}
                      {d.weight_pct ? ` · ${Math.round(d.weight_pct)}%` : ''}
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-surface2">
                    <div
                      className={`h-full rounded-full ${tone.bar}`}
                      style={{
                        width: `${
                          d.coverage === 'well_covered' ? 100 : d.coverage === 'partial' ? 50 : 0
                        }%`,
                      }}
                    />
                  </div>
                  <p className="truncate text-[11px] text-sec">
                    {d.sources?.length
                      ? `${DEPTH_COPY[d.depth] || 'covered'} · ${d.sources.join(', ')}`
                      : 'Nothing in your sources covers this yet'}
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
