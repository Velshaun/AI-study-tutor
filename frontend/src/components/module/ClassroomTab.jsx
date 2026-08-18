import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  ClipboardList,
  Headphones,
  HelpCircle,
  Layers,
  Loader2,
  Play,
  Sparkles,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import ModuleKpis from './ModuleKpis'
import { usePreferences } from '../../hooks/usePreferences'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { formatClock } from '../../lib/format'
import { path } from '../../routes'

/**
 * Classroom tab — per-module KPIs, a "Generate new" panel, and everything
 * already generated for the module (grouped by type, each labelled with its
 * domain).
 *
 * Generate buttons build the content type across the module's domains in the
 * background: the button shows a "Generating…" state, the learner stays put, and
 * a toast lands when it's ready. Nothing navigates away.
 */

const GENERATORS = {
  lecture: {
    Icon: Headphones,
    label: 'Lecture',
    ready: 'Lectures ready',
    error: 'Couldn’t build the lectures',
    async ensure(domain, prefs) {
      if (domain.lecture_id) return false
      await api.generateLecture({
        domain_id: domain.id,
        voice: prefs.tutor_voice,
        length: prefs.lecture_length,
      })
      return true
    },
  },
  flashcards: {
    Icon: Layers,
    label: 'Flashcards',
    ready: 'Flashcards ready',
    error: 'Couldn’t build the flashcards',
    async ensure(domain, prefs) {
      const cards = await api.flashcards(domain.id)
      if (Array.isArray(cards) && cards.length) return false
      await api.generateFlashcards({
        domain_id: domain.id,
        difficulty: prefs.flashcard_difficulty,
        count: 10,
      })
      return true
    },
  },
  quiz: {
    Icon: HelpCircle,
    label: 'Quiz',
    ready: 'Quizzes ready',
    error: 'Couldn’t build the quizzes',
    async ensure(domain, prefs) {
      const quizzes = await api.quizzes(domain.id)
      if (Array.isArray(quizzes) && quizzes.length) return false
      await api.generateQuiz({
        domain_id: domain.id,
        difficulty: prefs.quiz_difficulty,
        question_count: 10,
      })
      return true
    },
  },
  practice: {
    Icon: ClipboardList,
    label: 'Practice Exam',
    ready: 'Practice exams ready',
    error: 'Couldn’t build the practice exams',
    async ensure(domain) {
      await api.practiceQuestions(domain.id) // get-or-generate
      return true
    },
  },
}

export default function ClassroomTab({ moduleId, domains }) {
  return (
    <div className="space-y-8">
      <ModuleKpis moduleId={moduleId} />
      <GenerateNew moduleId={moduleId} domains={domains} />
      <GeneratedMedia moduleId={moduleId} />
    </div>
  )
}

function GenerateNew({ moduleId, domains }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const { preferences } = usePreferences()
  const [busy, setBusy] = useState(null)

  // Imported decks are studied individually; a bulk "generate everything" pass
  // shouldn't write a lecture for someone's Quizlet export.
  const unlocked = (domains || []).filter(
    (d) => d.status !== 'locked' && !d.is_imported_deck,
  )

  async function generate(kind) {
    if (busy || !unlocked.length) return
    const cfg = GENERATORS[kind]
    setBusy(kind)
    try {
      const results = await Promise.allSettled(
        unlocked.map((d) => cfg.ensure(d, preferences)),
      )
      queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module-stats', moduleId] })

      const built = results.filter((r) => r.status === 'fulfilled' && r.value).length
      const failed = results.filter((r) => r.status === 'rejected').length
      if (built > 0) toast.success(cfg.ready)
      else if (failed > 0) toast.error(cfg.error)
      else toast.info('Already generated for every domain')
    } catch (e) {
      toast.error(e?.message || cfg.error)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-3">
      <Heading Icon={Sparkles}>Generate new</Heading>
      <div className="space-y-2">
        {Object.entries(GENERATORS).map(([kind, cfg]) => (
          <button
            key={kind}
            onClick={() => generate(kind)}
            disabled={Boolean(busy) || unlocked.length === 0}
            className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface
                       px-4 py-3.5 text-left transition-colors hover:border-accent/50
                       disabled:opacity-60"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
              {busy === kind ? (
                <Loader2 size={18} className="animate-spin" aria-hidden="true" />
              ) : (
                <cfg.Icon size={18} aria-hidden="true" />
              )}
            </span>
            <span className="flex-1 text-sm font-medium text-pri">
              {busy === kind ? `Building ${cfg.label.toLowerCase()}…` : cfg.label}
            </span>
            {!busy && <ChevronRight size={16} className="text-sec" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </section>
  )
}

function GeneratedMedia({ moduleId }) {
  const navigate = useNavigate()
  const { data, isPending } = useQuery({
    queryKey: ['studio', moduleId],
    queryFn: ({ signal }) => api.studioMedia(moduleId, signal),
  })

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
  const practice = data?.practice ?? []
  const empty =
    !lectures.length && !flashcards.length && !quizzes.length && !practice.length

  return (
    <section className="space-y-4">
      <Heading>Generated media</Heading>

      {empty ? (
        <p className="card text-center text-sm text-sec">
          Nothing generated yet. Use “Generate new” above to build your first
          lecture, deck or quiz.
        </p>
      ) : (
        <>
          <Group label="Lectures" show={lectures.length > 0}>
            {lectures.map((l) => (
              <MediaRow
                key={l.id}
                Icon={Headphones}
                title="Lecture"
                domain={l.domain_title}
                meta={l.duration_secs ? formatClock(l.duration_secs) : 'Audio'}
                onOpen={() => navigate(path('lecture', { id: l.id }))}
                action="play"
              />
            ))}
          </Group>

          <Group label="Flashcards" show={flashcards.length > 0}>
            {flashcards.map((f) => (
              <MediaRow
                key={f.domain_id}
                Icon={Layers}
                title="Flashcard deck"
                domain={f.domain_title}
                meta={`${f.count} card${f.count === 1 ? '' : 's'}`}
                onOpen={() => navigate(path('flashcards', { domainId: f.domain_id }))}
              />
            ))}
          </Group>

          <Group label="Quizzes" show={quizzes.length > 0}>
            {quizzes.map((q) => (
              <MediaRow
                key={q.id}
                Icon={HelpCircle}
                title={q.title}
                domain={q.domain_title}
                meta={
                  `${q.question_count} question${q.question_count === 1 ? '' : 's'}` +
                  (q.score != null ? ` · ${Math.round(q.score)}%` : '')
                }
                onOpen={() =>
                  navigate(path('quizzes', { domainId: q.domain_id }))
                }
              />
            ))}
          </Group>

          <Group label="Practice Exams" show={practice.length > 0}>
            {practice.map((p) => (
              <MediaRow
                key={p.domain_id}
                Icon={ClipboardList}
                title="Practice exam"
                domain={p.domain_title}
                meta={`${p.count} question${p.count === 1 ? '' : 's'}`}
                onOpen={() => navigate(path('practiceMode', { domainId: p.domain_id }))}
              />
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

function MediaRow({ Icon, title, domain, meta, onOpen, action = 'open' }) {
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
        <p className="truncate text-xs text-sec">
          {domain ? `${domain} · ` : ''}
          {meta}
        </p>
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
