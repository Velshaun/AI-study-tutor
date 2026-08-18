import { useQueryClient } from '@tanstack/react-query'
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

import { api } from '../../lib/api'
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
 * Generative study actions — flashcards, quizzes, practice. Each config knows
 * how to check whether the content already exists and how to build it if not.
 * `ensure` returns `{ existed }`: an existing set opens straight away, a freshly
 * built one is announced by a toast the learner taps to open (they're never
 * dropped onto a waiting screen).
 */
const STUDY = {
  flashcards: {
    Icon: Layers,
    label: 'Flashcards',
    busy: 'Building flashcards…',
    ready: 'Flashcards ready',
    error: 'Couldn’t build flashcards',
    route: (d) => path('flashcards', { domainId: d.id }),
    async ensure({ domain, prefs, queryClient }) {
      const cards = await api.flashcards(domain.id)
      if (Array.isArray(cards) && cards.length) return { existed: true }
      await api.generateFlashcards({
        domain_id: domain.id,
        difficulty: prefs.flashcard_difficulty,
        count: 10,
      })
      queryClient.invalidateQueries({ queryKey: ['flashcards', domain.id] })
      return { existed: false }
    },
  },
  quizzes: {
    Icon: ClipboardList,
    label: 'Quizzes',
    busy: 'Building quiz…',
    ready: 'Quiz ready',
    error: 'Couldn’t build the quiz',
    route: (d) => path('quizzes', { domainId: d.id }),
    async ensure({ domain, prefs, queryClient }) {
      const quizzes = await api.quizzes(domain.id)
      if (Array.isArray(quizzes) && quizzes.length) return { existed: true }
      await api.generateQuiz({
        domain_id: domain.id,
        difficulty: prefs.quiz_difficulty,
        question_count: 10,
      })
      queryClient.invalidateQueries({ queryKey: ['quizzes', domain.id] })
      return { existed: false }
    },
  },
  practice: {
    Icon: Target,
    label: 'Practice',
    busy: 'Building practice exam…',
    ready: 'Practice exam ready',
    error: 'Couldn’t build the practice exam',
    route: (d) => path('practiceMode', { domainId: d.id }),
    async ensure({ domain, queryClient }) {
      // Get-or-generate on the server; prime the cache so opening is instant.
      const questions = await api.practiceQuestions(domain.id)
      queryClient.setQueryData(['practice-questions', domain.id], questions)
      return { existed: false }
    },
  },
}

/**
 * The module's ordered domains and their study surfaces.
 *
 * Study actions build in the background: clicking one keeps the learner on this
 * page, shows an inline "Building…" state on the tile, then a toast when the
 * content is ready. Locked domains show their state but don't act.
 */
export default function DomainList({ domains }) {
  if (!domains?.length) return null

  return (
    <section className="space-y-3">
      <SectionHeader>Domains</SectionHeader>
      <div className="space-y-3">
        {domains.map((d) => {
          // An imported deck is stored locked — it isn't part of the exam
          // blueprint — but its cards are study material, so it still offers
          // the study tiles (minus the lecture it will never have).
          const isDeck = d.is_imported_deck
          const locked = d.status === 'locked' && !isDeck
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
                    {isDeck
                      ? 'Imported deck'
                      : d.status === 'completed'
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
                  {!isDeck && <LectureTile domain={d} progress={progress} />}
                  <StudyTile domain={d} cfg={STUDY.flashcards} />
                  <StudyTile domain={d} cfg={STUDY.quizzes} />
                  <StudyTile domain={d} cfg={STUDY.practice} />
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

/** Base pill styling for a study action. */
const PILL =
  'inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors'

/** A plain navigation pill (Q&A, Review) — no generation. */
function StudyLink({ to, Icon, label, badge }) {
  return (
    <Link to={to} className={`${PILL} bg-surface2 text-sec hover:text-pri`}>
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

/** A generative study action: build-in-background, inline status, ready toast. */
function StudyTile({ domain, cfg }) {
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { preferences } = usePreferences()
  const [busy, setBusy] = useState(false)

  async function run() {
    if (busy) return
    setBusy(true)
    try {
      const { existed } = await cfg.ensure({ domain, prefs: preferences, queryClient })
      const open = () => navigate(cfg.route(domain))
      if (existed) open()
      else toast.success(cfg.ready, { action: { label: 'Open', onClick: open } })
    } catch (e) {
      toast.error(e?.message || cfg.error, { action: { label: 'Retry', onClick: run } })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={run}
      disabled={busy}
      aria-live="polite"
      className={`${PILL} bg-surface2 text-sec hover:text-pri disabled:opacity-100`}
    >
      {busy ? (
        <Loader2 size={14} className="animate-spin text-accent" aria-hidden="true" />
      ) : (
        <cfg.Icon size={14} aria-hidden="true" />
      )}
      {busy ? cfg.busy : cfg.label}
    </button>
  )
}

/**
 * The lecture action. An existing lecture opens straight away (the player
 * resumes from the saved position); otherwise it builds in the background and a
 * toast announces it. Labelled "Resume" when playback is part-way through.
 */
function LectureTile({ domain, progress }) {
  const navigate = useNavigate()
  const toast = useToast()
  const { preferences } = usePreferences()
  const [busy, setBusy] = useState(false)

  const resuming = Boolean(progress && !progress.done)

  async function run() {
    if (busy) return
    // Existing lecture → open/resume immediately.
    if (domain.lecture_id) {
      navigate(path('lecture', { id: domain.lecture_id }))
      return
    }
    setBusy(true)
    try {
      const lecture = await api.generateLecture({
        domain_id: domain.id,
        voice: preferences.tutor_voice,
        length: preferences.lecture_length,
      })
      if (lecture?.id) {
        const open = () => navigate(path('lecture', { id: lecture.id }))
        toast.success('Your lecture is ready', {
          action: { label: 'Open', onClick: open },
        })
      }
    } catch (e) {
      toast.error(e?.message || 'Couldn’t build the lecture', {
        action: { label: 'Retry', onClick: run },
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={run}
      disabled={busy}
      className={`${PILL} ${
        resuming
          ? 'bg-accent/15 text-accent2 hover:text-accent'
          : 'bg-surface2 text-sec hover:text-pri'
      }`}
    >
      {busy ? (
        <Loader2 size={14} className="animate-spin text-accent" aria-hidden="true" />
      ) : resuming ? (
        <Play size={14} aria-hidden="true" />
      ) : (
        <BookOpen size={14} aria-hidden="true" />
      )}
      {busy ? 'Generating lecture…' : resuming ? 'Resume' : 'Lecture'}
    </button>
  )
}
