import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ClipboardList, FileText, History, Layers, Loader2,
} from 'lucide-react'
import { useState } from 'react'

import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { summarise } from '../../lib/session'
import GenerateFromPool from '../study/GenerateFromPool'
import ResultsGrid from '../study/ResultsGrid'
import SectionHeading from './SectionHeading'

/**
 * Every past sitting, and every one of them still a source.
 *
 * A results screen is only on screen for as long as someone stands there. The
 * questions they got wrong are the most useful thing the app knows about them,
 * and until now that knowledge lasted exactly as long as the screen did.
 *
 * So a finished session is a row that opens: the same tiles as the results
 * screen, and an icon per thing it can become. Tapping one opens the same dials
 * used everywhere else, scoped to that session's missed and flagged questions
 * rather than to a container.
 */

const MEDIA = [
  { id: 'practice_exam', label: 'Practice exam', Icon: FileText },
  { id: 'quiz', label: 'Quiz', Icon: ClipboardList },
  { id: 'flashcards', label: 'Flashcards', Icon: Layers },
]

const KIND_LABEL = {
  exam: 'Exam', quiz: 'Quiz', flashcards: 'Flashcards', practice: 'Practice',
}

export default function SessionHistory({ moduleId }) {
  const { data, isPending } = useQuery({
    queryKey: ['sessions', moduleId],
    queryFn: ({ signal }) => api.sessions(moduleId, signal),
    enabled: Boolean(moduleId),
  })
  const sessions = Array.isArray(data) ? data : []

  if (isPending || !sessions.length) return null

  return (
    <section className="space-y-3">
      <SectionHeading Icon={History}>Past sessions</SectionHeading>
      <div className="space-y-2">
        {sessions.map((session) => (
          <SessionPill key={session.id} session={session} moduleId={moduleId} />
        ))}
      </div>
    </section>
  )
}

function SessionPill({ session, moduleId }) {
  const [open, setOpen] = useState(false)
  const [media, setMedia] = useState(null)
  const toast = useToast()
  const queryClient = useQueryClient()

  const results = Array.isArray(session.results) ? session.results : []
  const counts = summarise(results)

  const generate = useMutation({
    mutationFn: (body) =>
      api.generateFromSession(moduleId, session.id, body),
    onSuccess: (res) => {
      setMedia(null)
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      toast.success(
        `Made ${String(res.media).replace('_', ' ')} from ${res.used} question`
        + `${res.used === 1 ? '' : 's'}.`,
      )
    },
    onError: (e) => toast.error(e?.message || 'Could not generate that.'),
  })

  const pct = session.score_pct == null ? null : Math.round(session.score_pct)

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-pri">
            {session.title || KIND_LABEL[session.kind] || 'Session'}
            {/* The sitting stands; the thing it was of has been cleared away.
                Without this the title reads as something still there. */}
            {session.item_removed && (
              <span className="ms-1.5 rounded-full bg-surface2 px-1.5 py-0.5
                               text-[10px] font-medium uppercase tracking-wider text-sec">
                Removed
              </span>
            )}
          </span>
          <span className="block text-xs text-sec">
            {KIND_LABEL[session.kind] || session.kind}
            {' · '}
            {session.correct}/{session.total}
            {counts.flagged ? ` · ${counts.flagged} flagged` : ''}
          </span>
        </span>
        {pct != null && (
          <span
            className={`shrink-0 text-sm font-semibold tabular-nums ${
              pct >= 70 ? 'text-success' : pct >= 40 ? 'text-pri' : 'text-warning'
            }`}
          >
            {pct}%
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          {/* One icon per thing this sitting can become. Disabled when there
              is nothing to build from — a session you got everything right in
              and flagged nothing is a good outcome, not a source. */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-sec">
              Make from this
            </span>
            {MEDIA.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setMedia(id)}
                disabled={!counts.bankable}
                title={
                  counts.bankable
                    ? label
                    : 'Nothing missed or flagged in this one'
                }
                aria-label={label}
                className="flex size-9 items-center justify-center rounded-lg
                           bg-surface2 text-sec transition-colors
                           hover:text-accent2 disabled:opacity-40"
              >
                {generate.isPending && media === id ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Icon size={14} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>

          {/* Read-only: these answers are recorded and this is the history of
              them, not a second chance at them. */}
          <ResultsGrid results={results} locked />
        </div>
      )}

      <GenerateFromPool
        open={Boolean(media)}
        onClose={() => setMedia(null)}
        busy={generate.isPending}
        available={counts.bankable}
        title="Generate from this session"
        sources={{
          missed: counts.missed,
          flagged: counts.flagged,
          both: counts.bankable,
        }}
        onGenerate={(body) => generate.mutate({ ...body, media: media || body.media })}
      />
    </div>
  )
}
