import { Play } from 'lucide-react'
import { Link } from 'react-router-dom'

import { formatClock } from '../../lib/format'
import { path } from '../../routes'

/**
 * "Resume [Domain Title]" with a large play button (§5.4).
 *
 * Only rendered when the backend found a started-but-unfinished lecture, so
 * there is no empty variant — the dashboard omits the card entirely instead of
 * showing a disabled one.
 */
export default function ResumeCard({ resume }) {
  const title = resume.domain_title || 'your lecture'

  return (
    <Link
      to={path('lecture', { id: resume.lecture_id })}
      className="card-interactive block border-accent/40"
      style={{ backgroundColor: 'var(--accent-soft)' }}
    >
      <div className="flex items-center gap-4">
        <span
          className="flex size-14 shrink-0 items-center justify-center rounded-full
                     bg-accent text-white shadow-lg shadow-accent/20"
          aria-hidden="true"
        >
          <Play size={26} className="ml-1" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wider text-accent2">
            Pick up where you left off
          </p>
          <p className="mt-1 truncate text-lg font-semibold text-pri">
            Resume {title}
          </p>
          <p className="mt-0.5 truncate text-xs text-sec">
            {resume.module_title ? `${resume.module_title} · ` : ''}
            {formatClock(resume.position_secs)}
            {resume.duration_secs ? ` of ${formatClock(resume.duration_secs)}` : ''}
          </p>
        </div>
      </div>

      {resume.duration_secs > 0 && (
        <div
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface2"
          role="progressbar"
          aria-valuenow={Math.round(resume.progress_pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${Math.round(resume.progress_pct)}% complete`}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${Math.min(100, resume.progress_pct)}%` }}
          />
        </div>
      )}
    </Link>
  )
}
