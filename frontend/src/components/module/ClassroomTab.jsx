import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Layers,
  Loader2,
  Mic,
  Play,
  Sparkles,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import GeneratePreferencesModal from './GeneratePreferencesModal'
import ModuleKpis from './ModuleKpis'
import ReadinessCard from './ReadinessCard'
import SwipeToDelete from '../study/SwipeToDelete'
import { useConfirm } from '../../hooks/useConfirm'
import { useGeneration } from '../../hooks/useGeneration'
import { usePlayer } from '../../hooks/usePlayer'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { formatClock } from '../../lib/format'
import { path } from '../../routes'

/**
 * Classroom tab — per-module KPIs, one "Generate" panel, and everything already
 * generated for the module (grouped by type, each labelled with its domain).
 *
 * Generating is a single flow, and the only one: tap a media type, set the few
 * preferences that matter for it, and the modal closes straight away. The work
 * runs in the GenerationProvider — mounted above every route — so leaving the
 * module, or the tab, doesn't stop it. The tile keeps showing "Generating…"
 * whenever the learner comes back, and a toast offers to take them to the
 * finished content.
 */

/**
 * A count asked for across the module, split over its domains.
 *
 * Whole numbers, at least one each, and the remainder goes to the earlier
 * domains — so "50 cards across 3 domains" is 17/17/16 rather than 16.67.
 */
function share(total, index, domainCount) {
  const base = Math.floor(total / domainCount)
  const remainder = total % domainCount
  return Math.max(1, base + (index < remainder ? 1 : 0))
}

const GENERATORS = {
  lecture: {
    Icon: Mic,
    label: 'Lecture',
    async run(domains, values) {
      let first = null
      for (const domain of domains) {
        if (domain.lecture_id) {
          first = first || domain.lecture_id
          continue
        }
        const lecture = await api.generateLecture({
          domain_id: domain.id,
          voice: values.voice,
          length: values.length,
        })
        first = first || lecture?.id
      }
      return first ? path('lecture', { id: first }) : null
    },
  },
  flashcards: {
    Icon: Layers,
    label: 'Flashcards',
    async run(domains, values) {
      for (const [i, domain] of domains.entries()) {
        await api.generateFlashcards({
          domain_id: domain.id,
          count: share(values.count, i, domains.length),
        })
      }
      return domains[0] ? path('flashcards', { domainId: domains[0].id }) : null
    },
  },
  quiz: {
    Icon: CheckCircle2,
    label: 'Quiz',
    async run(domains, values) {
      for (const [i, domain] of domains.entries()) {
        await api.generateQuiz({
          domain_id: domain.id,
          difficulty: values.difficulty,
          question_count: share(values.count, i, domains.length),
        })
      }
      return domains[0] ? path('quizzes', { domainId: domains[0].id }) : null
    },
  },
  practice: {
    Icon: ClipboardList,
    label: 'Practice Exam',
    async run(domains, values) {
      // Every domain gets the full length: a practice exam is sat per domain,
      // and each should be as long as the real paper.
      for (const domain of domains) {
        await api.practiceQuestions(domain.id, { count: values.count })
      }
      return domains[0] ? path('practiceMode', { domainId: domains[0].id }) : null
    },
  },
}

export default function ClassroomTab({ moduleId, domains, examCount = 40 }) {
  return (
    <div className="space-y-8">
      <ModuleKpis moduleId={moduleId} />
      <ReadinessCard moduleId={moduleId} />
      <GenerateNew moduleId={moduleId} domains={domains} examCount={examCount} />
      <GeneratedMedia moduleId={moduleId} />
    </div>
  )
}

function GenerateNew({ moduleId, domains, examCount }) {
  const queryClient = useQueryClient()
  const generation = useGeneration()
  const [asking, setAsking] = useState(null)

  // Imported decks are studied individually; a bulk generate shouldn't write a
  // lecture for someone's Quizlet export.
  const unlocked = (domains || []).filter(
    (d) => d.status !== 'locked' && !d.is_imported_deck,
  )

  function generate(kind, values) {
    const cfg = GENERATORS[kind]
    setAsking(null)
    generation.start({
      moduleId,
      kind,
      label: cfg.label,
      run: async () => {
        const destination = await cfg.run(unlocked, values)
        queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
        queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
        queryClient.invalidateQueries({ queryKey: ['module-stats', moduleId] })
        return destination
      },
    })
  }

  return (
    <section className="space-y-3">
      <Heading Icon={Sparkles}>Generate</Heading>
      <div className="space-y-2">
        {Object.entries(GENERATORS).map(([kind, cfg]) => {
          const running = generation.isGenerating(moduleId, kind)
          return (
            <button
              key={kind}
              onClick={() => setAsking(kind)}
              disabled={running || unlocked.length === 0}
              className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface
                         px-4 py-3.5 text-left transition-colors hover:border-accent/50
                         disabled:opacity-60"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
                {running ? (
                  <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                ) : (
                  <cfg.Icon size={18} aria-hidden="true" />
                )}
              </span>
              <span className="flex-1 text-sm font-medium text-pri">
                {cfg.label}
                {running && (
                  <span className="ml-2 text-xs font-normal text-accent2">
                    Generating…
                  </span>
                )}
              </span>
              {!running && (
                <ChevronRight size={16} className="text-sec" aria-hidden="true" />
              )}
            </button>
          )
        })}
      </div>

      <GeneratePreferencesModal
        open={Boolean(asking)}
        kind={asking}
        label={asking ? GENERATORS[asking].label : ''}
        domainCount={unlocked.length || 1}
        recommendedExamCount={examCount}
        onClose={() => setAsking(null)}
        onGenerate={(values) => generate(asking, values)}
      />
    </section>
  )
}

function GeneratedMedia({ moduleId }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const toast = useToast()
  const player = usePlayer()
  const { data, isPending } = useQuery({
    queryKey: ['studio', moduleId],
    queryFn: ({ signal }) => api.studioMedia(moduleId, signal),
  })

  /**
   * Delete one generated item, once the learner has confirmed.
   *
   * The tile goes immediately and the list refetches behind it; a failure puts
   * it back by refetching, since the server is the authority on what survived.
   */
  async function remove({ label, run, playingId }) {
    const ok = await confirm({
      title: `Delete this ${label}?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return

    // Deleting the lecture that's playing would leave the player pointing at
    // audio that no longer exists, so it's dismissed first.
    if (playingId && player?.lecture?.id === playingId) player.close()

    try {
      await run()
      toast.success(`${label[0].toUpperCase()}${label.slice(1)} deleted`)
    } catch (e) {
      toast.error(e?.message || `Could not delete that ${label}.`)
    } finally {
      queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module-stats', moduleId] })
    }
  }

  if (isPending) {
    return (
      <section className="space-y-3">
        <Heading>Generated media</Heading>
        <div className="skeleton h-16 rounded-2xl" />
        <div className="skeleton h-16 rounded-2xl" />
      </section>
    )
  }

  const lectures = data?.lectures ?? []
  const flashcards = data?.flashcards ?? []
  const quizzes = data?.quizzes ?? []
  // Domain practice sets and whole exams — generated or imported from a PDF —
  // are the same thing to a learner, so they share a subsection.
  const practice = data?.practice ?? []
  const exams = data?.exams ?? []
  const empty =
    !lectures.length && !flashcards.length && !quizzes.length &&
    !practice.length && !exams.length

  return (
    <section className="space-y-4">
      <Heading>Generated media</Heading>

      {empty ? (
        <p className="card text-center text-sm text-sec">
          Nothing generated yet. Use “Generate” above to build your first
          lecture, deck, quiz or practice exam.
        </p>
      ) : (
        <>
          <Group label="Lectures" show={lectures.length > 0}>
            {lectures.map((l) => (
              <SwipeToDelete
                key={l.id}
                label="lecture"
                onDelete={() =>
                  remove({
                    label: 'lecture',
                    playingId: l.id,
                    run: () => api.deleteLecture(l.id),
                  })
                }
              >
                <MediaRow
                  Icon={Mic}
                  title={l.title}
                  subtitle={scope([
                    l.domain_title,
                    l.duration_secs ? formatClock(l.duration_secs) : 'Audio',
                    when(l.created_at),
                  ])}
                  onOpen={() => navigate(path('lecture', { id: l.id }))}
                  action="play"
                />
              </SwipeToDelete>
            ))}
          </Group>

          <Group label="Flashcard Decks" show={flashcards.length > 0}>
            {flashcards.map((f) => (
              <SwipeToDelete
                key={f.domain_id}
                label="deck"
                onDelete={() =>
                  remove({
                    label: 'deck',
                    run: () => api.deleteFlashcardDeck(f.domain_id),
                  })
                }
              >
                <MediaRow
                  Icon={Layers}
                  title={f.title || `${f.domain_title || 'Deck'} — ${f.count} cards`}
                  subtitle={scope([
                    f.domain_title,
                    `${f.count} card${f.count === 1 ? '' : 's'}`,
                    when(f.created_at),
                  ])}
                  onOpen={() => navigate(path('flashcards', { domainId: f.domain_id }))}
                />
              </SwipeToDelete>
            ))}
          </Group>

          <Group label="Quizzes" show={quizzes.length > 0}>
            {quizzes.map((q) => (
              <SwipeToDelete
                key={q.id}
                label="quiz"
                onDelete={() =>
                  remove({ label: 'quiz', run: () => api.deleteQuiz(q.id) })
                }
              >
                <MediaRow
                  Icon={CheckCircle2}
                  title={q.title}
                  subtitle={scope([
                    q.domain_title,
                    `${q.question_count} question${q.question_count === 1 ? '' : 's'}`,
                    q.score != null ? `${Math.round(q.score)}%` : null,
                    when(q.created_at),
                  ])}
                  onOpen={() => navigate(path('quizzes', { domainId: q.domain_id }))}
                />
              </SwipeToDelete>
            ))}
          </Group>

          <Group
            label="Practice Exams"
            show={practice.length > 0 || exams.length > 0}
          >
            {exams.map((e) => (
              <SwipeToDelete
                key={e.id}
                label="practice exam"
                onDelete={() =>
                  remove({ label: 'practice exam', run: () => api.deleteExam(e.id) })
                }
              >
                <MediaRow
                  Icon={ClipboardList}
                  title={e.title}
                  subtitle={scope([
                    `${e.question_count} question${e.question_count === 1 ? '' : 's'}`,
                    e.duration_minutes ? `${e.duration_minutes} min` : null,
                    when(e.created_at),
                  ])}
                  onOpen={() => navigate(path('examRun', { examId: e.id }))}
                />
              </SwipeToDelete>
            ))}
            {practice.map((p) => (
              <SwipeToDelete
                key={p.domain_id}
                label="practice set"
                onDelete={() =>
                  remove({
                    label: 'practice set',
                    run: () => api.deletePracticeSet(p.domain_id),
                  })
                }
              >
                <MediaRow
                  Icon={ClipboardList}
                  title={p.title || `${p.domain_title || 'Practice'} — ${p.count} questions`}
                  subtitle={scope([
                    p.domain_title,
                    `${p.count} question${p.count === 1 ? '' : 's'}`,
                    when(p.created_at),
                  ])}
                  onOpen={() => navigate(path('practiceMode', { domainId: p.domain_id }))}
                />
              </SwipeToDelete>
            ))}
          </Group>
        </>
      )}
    </section>
  )
}

function Group({ label, show, children }) {
  if (!show) return null
  return (
    <div className="space-y-2">
      <p className="px-1 text-xs font-semibold uppercase tracking-wider text-sec">
        {label}
      </p>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

/** "Covers X · 40 questions · Generated today" — skipping anything unknown. */
function scope(parts) {
  return parts.filter(Boolean).join(' · ')
}

/** How long ago something was generated, in words a glance can take in. */
function when(iso) {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null
  const days = Math.floor((Date.now() - then.getTime()) / 86400000)
  if (days <= 0) return 'Generated today'
  if (days === 1) return 'Generated yesterday'
  if (days < 7) return `Generated ${days} days ago`
  return `Generated ${then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

function MediaRow({ Icon, title, subtitle, onOpen, action = 'open' }) {
  return (
    <button
      onClick={onOpen}
      className="card-interactive flex w-full items-center gap-3 text-left"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-pri">{title}</p>
        <p className="truncate text-xs text-sec">{subtitle}</p>
      </div>
      {action === 'play' ? (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-white">
          <Play size={16} className="ml-0.5" aria-hidden="true" />
        </span>
      ) : (
        <ChevronRight size={18} className="shrink-0 text-sec" aria-hidden="true" />
      )}
    </button>
  )
}

function Heading({ Icon, children }) {
  return (
    <h2 className="flex items-center gap-2 border-l-2 border-accent pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
      {Icon && <Icon size={13} aria-hidden="true" />}
      {children}
    </h2>
  )
}
