import { useQuery } from '@tanstack/react-query'
import { AlertCircle, MessagesSquare, RefreshCw } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'

import EmptyState from '../components/EmptyState'
import PageTitle from '../components/PageTitle'
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
    <div className="space-y-8">
      <PageTitle
        onBack={() => navigate(-1)}
        subtitle="Every question you asked mid-lecture, grouped into sessions."
      >
        Q&amp;A History{domainTitle ? ` — ${domainTitle}` : ''}
      </PageTitle>

      {isPending ? (
        <div className="space-y-3" role="status" aria-label="Loading">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton h-28 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          centered
          icon={AlertCircle}
          title={isAuth ? 'Sign in to see your Q&A history' : 'Couldn’t load your sessions'}
          message={isAuth ? undefined : error?.message}
          action={
            !isAuth && (
              <button onClick={() => refetch()} className="btn-secondary">
                <RefreshCw size={15} aria-hidden="true" />
                Try again
              </button>
            )
          }
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          centered
          icon={MessagesSquare}
          title="No questions asked yet for this domain"
          message="Ask the tutor anything while a lecture plays — your sessions show up here for review."
        />
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
