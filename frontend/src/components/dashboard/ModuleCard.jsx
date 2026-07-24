import { ChevronRight, FileText } from 'lucide-react'
import { Link } from 'react-router-dom'

import { domainPillClass } from '../../lib/format'
import { path } from '../../routes'

/**
 * Module card with domain progress pills (§5.4).
 *
 * The list endpoint returns counts, not per-domain state, so pills render from
 * `domains` when a caller has them and fall back to a plain count otherwise —
 * fetching every module's domains just to colour the pills would be an N+1 on
 * the dashboard.
 */
export default function ModuleCard({ module }) {
  const domains = module.domains ?? []
  const processing = module.status !== 'ready' && module.status !== 'failed'

  return (
    <Link
      to={path('module', { id: module.id })}
      className="card-interactive block"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-pri">
            {module.title}
          </p>
          <p className="mt-0.5 truncate text-xs text-sec">
            {module.detected_subject || `${module.source_count ?? 0} source(s)`}
            {module.domain_count > 0 && ` · ${module.domain_count} domains`}
          </p>
        </div>
        <ChevronRight size={18} className="mt-0.5 shrink-0 text-sec" aria-hidden="true" />
      </div>

      {module.source_summary && (
        <p className="mt-3 line-clamp-2 text-sm text-sec">
          {module.source_summary}
        </p>
      )}

      {module.status === 'failed' ? (
        <p className="mt-3 text-xs text-warning">
          {module.error_message || 'Processing failed.'}
        </p>
      ) : processing ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-sec">
          <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
          {module.status_detail || 'Processing'}…
        </div>
      ) : domains.length > 0 ? (
        <div className="mt-4 flex gap-1" aria-label="Domain progress">
          {domains.map((d) => (
            <span
              key={d.id}
              title={`${d.title}: ${d.status}`}
              className={`h-1.5 flex-1 rounded-full ${domainPillClass(d.status)}`}
            />
          ))}
        </div>
      ) : (
        module.domain_count > 0 && (
          <div className="mt-4 flex items-center gap-2 text-xs text-sec">
            <FileText size={13} aria-hidden="true" />
            {module.domain_count} domains
          </div>
        )
      )}
    </Link>
  )
}
