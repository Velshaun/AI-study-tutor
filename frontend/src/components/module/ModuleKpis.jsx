import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Clock, ListChecks, Target } from 'lucide-react'

import { api } from '../../lib/api'
import { formatDuration, formatPercent } from '../../lib/format'

/**
 * Per-module KPI widgets (spec: stats live in the module view, scoped to that
 * module). A metric with no data shows an em dash rather than a misleading zero.
 */
export default function ModuleKpis({ moduleId }) {
  const { data, isPending } = useQuery({
    queryKey: ['module-stats', moduleId],
    queryFn: ({ signal }) => api.moduleStats(moduleId, signal),
  })

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
    },
    {
      label: 'Lectures',
      value: String(data.lectures_generated ?? 0),
      Icon: ListChecks,
    },
    {
      label: 'Time listened',
      value: formatDuration(data.listened_seconds),
      Icon: Clock,
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {widgets.map(({ label, value, hint, Icon }) => (
        <div key={label} className="card p-4">
          <div className="flex items-center gap-2 text-sec">
            <Icon size={15} aria-hidden="true" />
            <span className="truncate text-xs font-medium">{label}</span>
          </div>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-pri">{value}</p>
          {hint && <p className="mt-0.5 text-xs text-sec">{hint}</p>}
        </div>
      ))}
    </div>
  )
}
