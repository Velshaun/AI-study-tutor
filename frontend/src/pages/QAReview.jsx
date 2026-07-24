import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ArrowLeft, MessagesSquare, RefreshCw } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'

import QASessionCard from '../components/qa/QASessionCard'
import { api, ApiError } from '../lib/api'

/**
 * Per-domain Q&A review — spec §5.6b.
 *
 * Lists every session for a domain as an expandable card. Not in §5.2's route
 * table; added here because §5.6b describes a dedicated per-domain review
 * screen. Reached from the module/lecture screens once those exist.
 */
export default function QAReview() {
  const { domainId } = useParams()
  const navigate = useNavigate()

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['qa-sessions', domainId],
    queryFn: ({ signal }) => api.qaSessions(domainId, signal),
  })

  const isAuth = error instanceof ApiError && error.isAuth
  const sessions = Array.isArray(data) ? data : []
  const domainTitle = sessions[0]?.domain_title

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <button onClick={() => navigate(-1)} className="btn-ghost -ml-2">
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-pri">
            Q&amp;A History{domainTitle ? ` — ${domainTitle}` : ''}
          </h1>
          <p className="mt-0.5 text-sm text-sec">
            Every question you asked mid-lecture, grouped into sessions.
          </p>
        </div>
      </header>

      {isPending ? (
        <div className="space-y-3" role="status" aria-label="Loading">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton h-28 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <div className="card flex flex-col items-center gap-4 py-12 text-center">
          <AlertCircle size={26} className="text-warning" aria-hidden="true" />
          <p className="max-w-xs text-sm text-sec">
            {isAuth
              ? 'Sign in to see your Q&A history.'
              : error?.message || 'Couldn’t load your sessions.'}
          </p>
          {!isAuth && (
            <button onClick={() => refetch()} className="btn-secondary">
              <RefreshCw size={15} aria-hidden="true" />
              Try again
            </button>
          )}
        </div>
      ) : sessions.length === 0 ? (
        <div className="card flex flex-col items-center gap-4 py-12 text-center">
          <MessagesSquare size={26} className="text-sec" aria-hidden="true" />
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-pri">
              No questions asked yet for this domain
            </h2>
            <p className="mx-auto max-w-xs text-sm text-sec">
              Ask the tutor anything while a lecture plays — your sessions show
              up here for review.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => (
            <QASessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  )
}
