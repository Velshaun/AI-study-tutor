import {
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Flag,
  Layers,
  Loader2,
  Lock,
  MessagesSquare,
  Play,
  Target,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { ApiError, api } from '../../lib/api'
import { domainPillClass, formatClock } from '../../lib/format'
import { usePreferences } from '../../hooks/usePreferences'
import { useToast } from '../../hooks/useToast'
import { path } from '../../routes'
import SectionHeader from '../SectionHeader'

/** How far into a lecture counts as "started" — below this it reads as fresh. */
const RESUME_THRESHOLD_SECS = 5

/** A domain's lecture progress, or null when there's nothing meaningful to show. */
function lectureProgress(d) {
  const pos = d.last_position_secs || 0
  const total = d.lecture_duration_secs || 0
  if (d.status === 'completed') return { pct: 100, pos, total, done: true }
  if (!d.lecture_id || total <= 0 || pos < RESUME_THRESHOLD_SECS) return null
  const pct = Math.min(100, Math.round((pos / total) * 100))
  return { pct, pos, total, done: pct >= 99 }
}

/**
 * The module's ordered domains, each linking to its study surfaces. Locked
 * domains show their state but don't link onward.
 *
 * Flashcards/quizzes/Q&A are direct links — those pages are domain-scoped and
 * generate-on-demand. A lecture is keyed by its own id, and a domain may not
 * have one yet, so "Lecture" is a get-or-generate action instead of a link.
 */
export default function DomainList({ domains }) {
  if (!domains?.length) return null

  return (
    <section className="space-y-3">
      <SectionHeader>Domains</SectionHeader>
      <div className="space-y-3">
        {domains.map((d) => {
          const locked = d.status === 'locked'
          const progress = lectureProgress(d)
          return (
            <div key={d.id} className="card space-y-3">
              <div className="flex items-start gap-3">
                <span
                  className={`mt-1 size-2 shrink-0 rounded-full ${domainPillClass(d.status)}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-pri">{d.title}</p>
                  <p className="text-xs text-sec">
                    {d.weight_pct ? `${Math.round(d.weight_pct)}% of exam · ` : ''}
                    {d.status === 'completed'
                      ? 'Completed'
                      : progress
                        ? 'In progress'
                        : locked
                          ? 'Locked'
                          : 'Available'}
                  </p>
                </div>
                {d.status === 'completed' && (
                  <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden="true" />
                )}
                {locked && <Lock size={15} className="shrink-0 text-sec" aria-hidden="true" />}
              </div>

              {/* Lecture progress */}
              {!locked && progress && (
                <div className="space-y-1">
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ${
                        progress.done ? 'bg-success' : 'bg-accent'
                      }`}
                      style={{ width: `${progress.pct}%` }}
                    />
                  </div>
                  <p className="text-right text-[11px] tabular-nums text-sec">
                    {progress.done
                      ? 'Lecture complete'
                      : `${formatClock(progress.pos)} / ${formatClock(progress.total)}`}
                  </p>
                </div>
              )}

              {!locked && (
                <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                  <LectureAction domain={d} progress={progress} />
                  <StudyLink to={path('flashcards', { domainId: d.id })} Icon={Layers} label="Flashcards" />
                  <StudyLink to={path('quizzes', { domainId: d.id })} Icon={ClipboardList} label="Quizzes" />
                  <StudyLink to={path('practiceMode', { domainId: d.id })} Icon={Target} label="Practice" />
                  {d.review_later_count > 0 && (
                    <StudyLink
                      to={path('reviewLater', { domainId: d.id })}
                      Icon={Flag}
                      label="Review"
                      badge={d.review_later_count}
                    />
                  )}
                  <StudyLink to={path('qaReview', { domainId: d.id })} Icon={MessagesSquare} label="Q&A" />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function StudyLink({ to, Icon, label, badge }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-surface2 px-3 py-1.5
                 text-xs font-medium text-sec transition-colors hover:text-pri"
    >
      <Icon size={14} aria-hidden="true" />
      {label}
      {badge > 0 && (
        <span className="ml-0.5 inline-flex min-w-[1.15rem] items-center justify-center rounded-full
                         bg-warning px-1 text-[10px] font-bold text-white tabular-nums">
          {badge}
        </span>
      )}
    </Link>
  )
}

/**
 * Opens the domain's lecture. If one already exists it jumps straight there
 * (the player resumes from the saved position); otherwise it generates one
 * first. Labelled "Resume" when playback is part-way through, so a returning
 * learner sees where to pick back up.
 */
function LectureAction({ domain, progress }) {
  const navigate = useNavigate()
  const { preferences } = usePreferences()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const resuming = Boolean(progress && !progress.done)

  async function open() {
    // Existing lecture — go straight to it; the player restores the position.
    if (domain.lecture_id) {
      navigate(path('lecture', { id: domain.lecture_id }))
      return
    }
    setBusy(true)
    try {
      let lecture
      try {
        lecture = await api.lectureForDomain(domain.id)
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err
        // No lecture yet — generate one with the saved voice/length.
        lecture = await api.generateLecture({
          domain_id: domain.id,
          voice: preferences.tutor_voice,
          length: preferences.lecture_length,
        })
        toast.success('Lecture saved')
      }
      if (lecture?.id) navigate(path('lecture', { id: lecture.id }))
    } catch (err) {
      toast.error(err?.message || 'Could not open the lecture')
      setBusy(false)
    }
  }

  return (
    <button
      onClick={open}
      disabled={busy}
      className={[
        'inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-1.5',
        'text-xs font-medium transition-colors',
        resuming
          ? 'bg-accent/15 text-accent2 hover:text-accent'
          : 'bg-surface2 text-sec hover:text-pri',
      ].join(' ')}
    >
      {busy ? (
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      ) : resuming ? (
        <Play size={14} aria-hidden="true" />
      ) : (
        <BookOpen size={14} aria-hidden="true" />
      )}
      {resuming ? 'Resume' : 'Lecture'}
    </button>
  )
}
