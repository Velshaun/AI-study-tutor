import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDownRight, ArrowUpLeft, Loader2, MessageCircle, Volume2 } from 'lucide-react'
import { useRef, useState } from 'react'

import { api } from '../../lib/api'

/**
 * A single Q&A session as an expandable card — spec §5.6b / §5.6c.
 *
 * Collapsed, it shows the session title, a badge of how many genuine questions
 * it held, and a preview of the first exchange. Tapping the diagonal expand
 * icon reveals the full dialogue in place — no navigation — lazily fetching it
 * the first time and caching thereafter.
 *
 * The badge is the load-bearing visual. §5.6c fixes four tiers that escalate in
 * both size and colour, so the number reads at a glance as "quick clarification"
 * through to "weak area worth revisiting":
 *
 *   1    quick, understood at once      small · neutral · muted
 *   2–3  a couple of follow-ups         normal · accent border
 *   4–6  took some back-and-forth       larger · accent fill
 *   7+   deep uncertainty, a weak area  bold · green highlight
 *
 * The count itself is knowledge-questions-only, enforced server-side: a session
 * of "okay, got it, ready to continue" three times over one real question still
 * reads [1].
 */

function badgeTier(count) {
  // 7+ — a struggle topic. Solid green fill, white, bold: the loudest tier.
  if (count >= 7) {
    return 'px-2.5 py-1 text-sm font-bold border-transparent bg-success text-white'
  }
  // 4–6 — moderate confusion. Solid accent fill, white, slightly larger.
  if (count >= 4) {
    return 'px-2.5 py-1 text-sm font-semibold border-transparent bg-accent text-white'
  }
  // 2–3 — a short conversation. Normal size, accent border, transparent fill.
  if (count >= 2) {
    return 'px-2 py-0.5 text-xs font-medium border-accent/50 bg-transparent text-accent2'
  }
  // 1 — a quick clarification. Small, neutral, muted.
  return 'px-2 py-0.5 text-xs font-normal border-border bg-surface2 text-sec'
}

function Bubble({ role, text, muted }) {
  const isQ = role === 'q'
  return (
    <div className={isQ ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={[
          'max-w-[88%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
          isQ
            ? 'rounded-br-sm bg-surface2 text-pri'
            : 'rounded-bl-sm border border-accent/25 bg-surface text-pri',
          muted ? 'opacity-60' : '',
        ].join(' ')}
      >
        {!isQ && !muted && (
          <span className="mb-0.5 block text-[11px] font-medium text-accent2">
            Tutor
          </span>
        )}
        {text}
      </div>
    </div>
  )
}

export default function QASessionCard({ session }) {
  // Two flags: `expanded` drives the open/closed UI; `hasOpened` latches true on
  // first expand so react-query keeps the fetched dialogue cached even after
  // collapsing — set in the toggle handler, never during render.
  const [expanded, setExpanded] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)

  const toggle = () =>
    setExpanded((open) => {
      if (!open) setHasOpened(true)
      return !open
    })

  const count = session.question_count || 0
  const title = session.session_title || 'Q&A session'

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['qa-exchanges', session.id],
    queryFn: ({ signal }) => api.qaExchanges(session.id, signal),
    enabled: hasOpened,
    staleTime: 60_000,
  })

  const exchanges = data?.exchanges ?? []

  return (
    <div className="card relative overflow-hidden">
      {/* Header */}
      <button
        onClick={toggle}
        className="flex w-full items-start gap-3 text-left"
        aria-expanded={expanded}
      >
        <MessageCircle size={16} className="mt-0.5 shrink-0 text-sec" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-sec">
              Q&amp;A Session
            </span>
            <span className="text-sec">•</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-pri">
              {title}
            </span>
          </div>
        </div>
        <span
          className={`shrink-0 self-start rounded-full border tabular-nums leading-none ${badgeTier(count)}`}
          aria-label={`${count} question${count === 1 ? '' : 's'}`}
        >
          {count}
        </span>
      </button>

      {/* Collapsed preview. Right padding clears the absolute expand icon so
          the second answer line never runs underneath it. */}
      {!expanded && (
        <div className="mt-3 space-y-1.5 pl-7 pr-9">
          {session.preview_question && (
            <p className="truncate text-sm text-pri">
              <span className="text-sec">Q:</span> {session.preview_question}
            </p>
          )}
          {session.preview_answer && (
            <p className="line-clamp-2 text-sm text-sec">
              <span className="text-sec">A:</span> {session.preview_answer}
            </p>
          )}
        </div>
      )}

      {/* Expanded dialogue */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {/* Bottom padding leaves room for the absolute expand icon below
                the last bubble. */}
            <div className="mt-4 space-y-3 pl-7 pb-8">
              {isPending ? (
                <div className="flex items-center gap-2 py-4 text-sm text-sec">
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                  Loading conversation…
                </div>
              ) : isError ? (
                <div className="py-2 text-sm text-warning">
                  Couldn&rsquo;t load this conversation.{' '}
                  <button onClick={() => refetch()} className="underline">
                    Retry
                  </button>
                </div>
              ) : (
                exchanges.map((ex) => {
                  const knowledge = ex.exchange_kind === 'knowledge'
                  return (
                    <div key={ex.id} className="space-y-2">
                      <Bubble
                        role="q"
                        text={ex.question_summary || '…'}
                        muted={!knowledge}
                      />
                      <div className="flex items-end gap-2">
                        <Bubble role="a" text={ex.answer} muted={!knowledge} />
                        {ex.answer_audio_url && (
                          <PlayAnswer url={ex.answer_audio_url} />
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Expand icon — diagonal arrow, bottom-right (§5.6b) */}
      <button
        onClick={toggle}
        aria-label={expanded ? 'Collapse' : 'Expand'}
        className="absolute bottom-3 right-3 flex size-8 items-center justify-center
                   rounded-lg text-sec transition-colors hover:bg-surface2 hover:text-pri"
      >
        {expanded ? (
          <ArrowUpLeft size={18} aria-hidden="true" />
        ) : (
          <ArrowDownRight size={18} aria-hidden="true" />
        )}
      </button>
    </div>
  )
}

/** Small inline player for an answer's cached narration. */
function PlayAnswer({ url }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)

  const toggle = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio(url)
      audioRef.current.addEventListener('ended', () => setPlaying(false))
    }
    if (playing) {
      audioRef.current.pause()
      setPlaying(false)
    } else {
      audioRef.current.play().then(() => setPlaying(true)).catch(() => {})
    }
  }

  return (
    <button
      onClick={toggle}
      aria-label={playing ? 'Pause answer' : 'Play answer'}
      className={[
        'flex size-8 shrink-0 items-center justify-center rounded-full transition-colors',
        playing ? 'bg-accent text-white' : 'bg-surface2 text-sec hover:text-pri',
      ].join(' ')}
    >
      <Volume2 size={15} aria-hidden="true" />
    </button>
  )
}
