import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Play, Target } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { api } from '../../lib/api'
import { nextAction, rankDomains } from '../../lib/priority'
import { path } from '../../routes'

/**
 * The one next thing, above everything else on the screen.
 *
 * Five domains of accumulating material is a wall, and the answer to "what do I
 * open" was previously somewhere inside it — you had to read the whole board to
 * find the weakest thing on it. This names one action and gives the reason, so
 * the board becomes something to browse rather than something to parse.
 *
 * It ranks by marks still on the table rather than by weakness, for the reason
 * in `lib/priority`: a domain at 40% worth 4% of the paper is a worse evening
 * than one at 60% worth 25%.
 *
 * Guidance, never permission. Every domain below is open whatever this says —
 * the card is an opinion, and disagreeing with it costs one scroll.
 */
export default function ContinueCard({ moduleId, domains, performance, hasBaseline }) {
  const navigate = useNavigate()

  // Finishing something beats starting something, so an unfinished lecture wins
  // the slot. Failing quietly is right here: the card is a shortcut, and a
  // shortcut that errors is worse than one that falls back to the ranking.
  const { data: open } = useQuery({
    queryKey: ['open-attempts'],
    queryFn: ({ signal }) => api.openAttempts(signal),
    retry: false,
    staleTime: 60_000,
  })

  const ranked = rankDomains(domains || [], performance)
  const resume = (Array.isArray(open) ? open : []).find(
    (a) => a.module_id === moduleId && a.item_type === 'lecture',
  )
  const action = nextAction({ ranked, resume, hasBaseline })
  if (!action) return null

  function go() {
    if (action.kind === 'resume' && action.lectureId) {
      navigate(path('lecture', { id: action.lectureId }))
    } else if (action.domainId) {
      navigate(path('practiceMode', { domainId: action.domainId }))
    }
  }

  const Icon = action.kind === 'resume' ? Play : Target

  return (
    <button
      onClick={go}
      className="card-interactive flex w-full items-center gap-4 border-accent/40 text-left"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl
                       bg-accent/15 text-accent2">
        <Icon size={20} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold uppercase tracking-wider text-accent2">
          {action.kind === 'resume' ? 'Pick up where you left off' : 'Study next'}
        </span>
        <span className="block truncate text-sm font-medium text-pri">{action.title}</span>
        <span className="block truncate text-xs text-sec">{action.reason}</span>
      </span>
      <ArrowRight size={18} className="shrink-0 text-sec" aria-hidden="true" />
    </button>
  )
}
