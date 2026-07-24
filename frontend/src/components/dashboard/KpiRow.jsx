import { BookMarked, CheckCircle2, Clock, Target } from 'lucide-react'

import { formatDuration, formatPercent } from '../../lib/format'

/**
 * The four KPI widgets (§5.4).
 *
 * A metric with no data shows an em dash rather than a zero — "0%" quiz
 * average reads as failing every quiz, when the truth is that none have been
 * taken yet.
 */
export default function KpiRow({ stats }) {
  const widgets = [
    {
      label: 'Modules',
      value: String(stats.total_modules ?? 0),
      Icon: BookMarked,
    },
    {
      label: 'Domains done',
      value:
        stats.domains_total > 0
          ? `${stats.domains_completed}/${stats.domains_total}`
          : '—',
      Icon: CheckCircle2,
    },
    {
      label: 'Quiz average',
      value: formatPercent(stats.quiz_average_score),
      hint:
        stats.quizzes_taken > 0
          ? `${stats.quizzes_taken} taken`
          : 'none yet',
      Icon: Target,
    },
    {
      label: 'This week',
      value: formatDuration(stats.study_seconds_this_week),
      hint: 'study time',
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
          <p className="mt-2 text-2xl font-semibold tabular-nums text-pri">
            {value}
          </p>
          {hint && <p className="mt-0.5 text-xs text-sec">{hint}</p>}
        </div>
      ))}
    </div>
  )
}
