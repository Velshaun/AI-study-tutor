import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Clock, ListChecks, Target } from 'lucide-react'
import { useState } from 'react'

import KpiDetail from './KpiDetail'
import { api } from '../../lib/api'
import { formatDuration, formatPercent } from '../../lib/format'
import { listenedDetail } from '../../lib/mediaLabels'

/**
 * Per-module KPI widgets (spec: stats live in the module view, scoped to that
 * module). A metric with no data shows an em dash rather than a misleading zero.
 *
 * A number that counts things you own should be a way into them. "3 lectures"
 * was a readout, and the three lectures it counted were somewhere below, mixed
 * in with everything else the module holds — so recognising your own figure
 * bought you nothing. Tapping one now opens exactly what it counted and nothing
 * else, grouped by domain, using the Classroom's own rows.
 *
 * "Domains done" deliberately stays a readout. What it counts is domains, and
 * the list of those is the body of the screen directly underneath — opening a
 * second copy of it over the top would be a view of something already in view.
 */
export default function ModuleKpis({ moduleId }) {
  // Same query key the Classroom uses, so this reads its cache rather than
  // fetching a second copy — and the two can never disagree about what exists.
  const { data: media } = useQuery({
    queryKey: ['studio', moduleId],
    queryFn: ({ signal }) => api.studioMedia(moduleId, signal),
    enabled: Boolean(moduleId),
  })
  const { data, isPending } = useQuery({
    queryKey: ['module-stats', moduleId],
    queryFn: ({ signal }) => api.moduleStats(moduleId, signal),
  })
  const [openKpi, setOpenKpi] = useState(null)

  if (isPending) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-20 rounded-2xl" />
        ))}
      </div>
    )
  }
  if (!data) return null

  const allLectures = media?.lectures || []
  const quizzes = media?.quizzes || []
  // Only the ones actually played — the figure is time listened, not time
  // available, and showing every lecture would answer a different question.
  const listened = allLectures
    .filter((l) => (l.last_position_secs || 0) > 0)
    .map((l) => ({ ...l, __detail: listenedDetail(l) }))

  const widgets = [
    {
      label: 'Domains done',
      value:
        data.domains_total > 0
          ? `${data.domains_completed}/${data.domains_total}`
          : '—',
      Icon: CheckCircle2,
    },
    {
      label: 'Quiz average',
      value: formatPercent(data.quiz_average_score),
      hint: data.quizzes_taken > 0 ? `${data.quizzes_taken} taken` : 'none yet',
      Icon: Target,
      detail: {
        kind: 'quiz', items: quizzes, title: 'Quizzes',
        empty: 'No quizzes in this module yet.',
      },
    },
    {
      label: 'Lectures',
      value: String(data.lectures_generated ?? 0),
      Icon: ListChecks,
      detail: {
        kind: 'lecture', items: allLectures, title: 'Lectures',
        empty: 'No lectures in this module yet.',
      },
    },
    {
      label: 'Time listened',
      value: formatDuration(data.listened_seconds),
      Icon: Clock,
      detail: {
        kind: 'lecture', items: listened, title: 'What you have listened to',
        empty: 'You haven’t started a lecture in this module yet.',
      },
    },
  ]

  const active = widgets.find((w) => w.label === openKpi)?.detail

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {widgets.map(({ label, value, hint, Icon, detail }) => {
          const body = (
            <>
              <div className="flex items-center gap-2 text-sec">
                <Icon size={15} aria-hidden="true" />
                <span className="truncate text-xs font-medium">{label}</span>
              </div>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-pri">{value}</p>
              {hint && <p className="mt-0.5 text-xs text-sec">{hint}</p>}
            </>
          )
          // A tile with nothing behind it stays a tile. Offering a tap that
          // opens an empty sheet teaches people the taps do nothing.
          return detail?.items.length ? (
            <button
              key={label}
              type="button"
              onClick={() => setOpenKpi(label)}
              aria-label={`${label}: ${value} — show them`}
              className="card p-4 text-left transition-colors hover:border-accent/40"
            >
              {body}
            </button>
          ) : (
            <div key={label} className="card p-4">{body}</div>
          )
        })}
      </div>

      <KpiDetail
        open={Boolean(active)}
        onClose={() => setOpenKpi(null)}
        title={active?.title || ''}
        empty={active?.empty || ''}
        kind={active?.kind}
        items={active?.items || []}
      />
    </>
  )
}
