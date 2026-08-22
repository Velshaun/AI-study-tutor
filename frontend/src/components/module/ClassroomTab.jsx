import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Layers,
  Loader2,
  Mic,
  Sparkles,
  Target,
} from 'lucide-react'
import { useState } from 'react'

import DomainClassroom from './DomainClassroom'
import ExamsSection from './ExamsSection'
import GeneratePreferencesModal from './GeneratePreferencesModal'
import ModuleKpis from './ModuleKpis'
import ContentReadinessCard from './ContentReadinessCard'
import LearnerReadinessCard from './LearnerReadinessCard'
import { useGeneration } from '../../hooks/useGeneration'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import * as lectures from '../../lib/lectures'
import { path } from '../../routes'
import ContainerSection from './ContainerSection'
import ContinueCard from './ContinueCard'
import BaselineSection from './BaselineSection'
import SessionHistory from './SessionHistory'

/**
 * Classroom tab — the module organised the way its exam is.
 *
 * It used to be one pool grouped by media type: every lecture together, every
 * deck together, every quiz together. That mirrored the tables rather than the
 * revision — nobody sits down to "do some flashcards", they sit down to work on
 * a topic and want that topic's lecture, deck and quiz in one place. The domain
 * was on every item already; nothing grouped by it.
 *
 * So the order here is: where you stand, what to do about it, the papers that
 * span everything, then the domains themselves. Practice exams sit above the
 * domain list rather than in it because they are the one thing that isn't
 * scoped to a domain.
 *
 * Generating still runs in the GenerationProvider, above every route, so
 * leaving the tab doesn't stop the work.
 */

// How often to re-ask while a lecture is still being written or narrated.
const GENERATING_POLL_MS = 4000

/**
 * A count asked for across the module, split over its domains — bent towards
 * the ones going badly.
 *
 * `need` is the per-domain multiplier the server derives from graded results:
 * a domain being failed earns more questions than one being passed. Falls back
 * to an even split when nothing has been graded yet, because a preference
 * invented from no evidence is worse than no preference.
 */
function allocate(total, domains, need) {
  const weights = domains.map((d) => Math.max(0.01, need?.[d.id] ?? 1))
  const sum = weights.reduce((a, b) => a + b, 0)
  const exact = weights.map((w) => (total * w) / sum)
  const floors = exact.map((v) => Math.max(1, Math.floor(v)))
  let left = total - floors.reduce((a, b) => a + b, 0)
  // Hand any leftover to the largest fractional parts, neediest first.
  const order = exact
    .map((v, i) => [i, v - Math.floor(v)])
    .sort((a, b) => b[1] - a[1])
  for (const [i] of order) {
    if (left <= 0) break
    floors[i] += 1
    left -= 1
  }
  return floors
}

const GENERATORS = {
  lecture: {
    Icon: Mic,
    label: 'Lecture',
    async run(domains, values) {
      let first = null
      for (const domain of domains) {
        if (domain.lecture_id && lectures.isReady(domain.lecture_status)) {
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
      if (!first) return null
      // Generation answers as soon as the row exists, so the destination isn't
      // openable yet. Wait for it, or the completion toast hands the learner a
      // button onto an empty player.
      const final = await lectures.waitForLecture(first)
      return lectures.isReady(final.status) ? path('lecture', { id: first }) : null
    },
  },
  flashcards: {
    Icon: Layers,
    label: 'Flashcards',
    async run(domains, values, need) {
      const counts = allocate(values.count, domains, need)
      for (const [i, domain] of domains.entries()) {
        await api.generateFlashcards({ domain_id: domain.id, count: counts[i] })
      }
      return domains[0] ? path('flashcards', { domainId: domains[0].id }) : null
    },
  },
  quiz: {
    Icon: CheckCircle2,
    label: 'Quiz',
    async run(domains, values, need) {
      const counts = allocate(values.count, domains, need)
      for (const [i, domain] of domains.entries()) {
        await api.generateQuiz({
          domain_id: domain.id,
          difficulty: values.difficulty,
          question_count: counts[i],
        })
      }
      return domains[0] ? path('quizzes', { domainId: domains[0].id }) : null
    },
  },
  practice: {
    Icon: ClipboardList,
    label: 'Practice questions',
    async run(domains, values) {
      // Every domain gets the full length: a practice set is sat per domain,
      // and each should be as long as the real paper.
      for (const domain of domains) {
        await api.practiceQuestions(domain.id, { count: values.count })
      }
      return domains[0] ? path('practiceMode', { domainId: domains[0].id }) : null
    },
  },
}

export default function ClassroomTab({ moduleId, domains, examCount = 40 }) {
  const queryClient = useQueryClient()

  const { data: media, isPending } = useQuery({
    queryKey: ['studio', moduleId],
    queryFn: ({ signal }) => api.studioMedia(moduleId, signal),
    // Something being built is listed while it builds, so the list keeps asking
    // until it stops being a spinner — and stops the moment nothing is running.
    refetchInterval: (query) =>
      (query.state.data?.lectures || []).some((l) => lectures.isGenerating(l.status))
        ? GENERATING_POLL_MS
        : false,
    refetchIntervalInBackground: false,
  })

  const { data: performance } = useQuery({
    queryKey: ['performance', moduleId],
    queryFn: ({ signal }) => api.performance(moduleId, signal),
  })

  // No status filter any more: nothing is locked, and the only domains that
  // sit out of bulk generation are imported decks.
  const studyable = (domains || []).filter((d) => !d.is_imported_deck)

  return (
    <div className="space-y-8">
      <ModuleKpis moduleId={moduleId} />

      {/* Above everything: five domains of accumulating material is a wall, and
          the answer to "what do I open" should not be somewhere inside it. */}
      <ContinueCard
        moduleId={moduleId}
        domains={domains}
        performance={performance}
        hasBaseline={performance?.has_baseline ?? true}
      />

      {/* Its own section, above practice exams and never mixed with them: the
          baseline is the line the others are measured against, not one of
          them. Offers the assessment until it is taken, then becomes the
          permanent record and the comparison — the offer never returns. */}
      <BaselineSection
        moduleId={moduleId}
        questionCount={examCount}
        canTake={Boolean(performance && !performance.has_baseline && studyable.length > 0)}
      />

      <ExamsSection
        moduleId={moduleId}
        exams={media?.exams ?? []}
        questionCount={examCount}
        onDeleted={() => {
          queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
          queryClient.invalidateQueries({ queryKey: ['exam-attempts', moduleId] })
        }}
      />

      {/* The two containers. Module-scoped and spanning the whole blueprint,
          which is exactly where practice exams sit — so they sit alongside
          them rather than inside the domain list. */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 border-l-2 border-accent pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
          <Target size={13} aria-hidden="true" />
          Your own questions
        </h2>
        <ContainerSection moduleId={moduleId} container="missed" />
        <ContainerSection moduleId={moduleId} container="qa" />
      </section>

      {/* Every finished sitting, still a source. A results screen lasts as long
          as someone stands in front of it; what they got wrong is worth more
          than that. */}
      <SessionHistory moduleId={moduleId} />

      {isPending ? (
        <div className="space-y-2">
          <div className="skeleton h-16 rounded-2xl" />
          <div className="skeleton h-16 rounded-2xl" />
        </div>
      ) : (
        <DomainClassroom
          moduleId={moduleId}
          domains={domains}
          media={media}
          performance={performance}
          examCount={examCount}
        />
      )}

      {/* Two measures, two sections, deliberately far apart and never added
          together. One says go and find more material; the other says go and
          study. The single blended score they replaced moved when either input
          changed, so it could not answer either question. */}
      <ContentReadinessCard moduleId={moduleId} />

      <LearnerReadinessCard moduleId={moduleId} />

      <GenerateAll
        moduleId={moduleId}
        domains={domains}
        performance={performance}
        examCount={examCount}
      />
    </div>
  )
}

/**
 * Build one media type across every domain at once.
 *
 * Still here alongside the per-domain buttons because they answer different
 * questions: this one is "set me up for the whole module", the domain buttons
 * are "I'm working on this topic now". What changed is the split — a fixed
 * even share ignored that some domains need three times the practice of others.
 */
function GenerateAll({ moduleId, domains, performance, examCount }) {
  const queryClient = useQueryClient()
  const generation = useGeneration()
  const toast = useToast()
  const [asking, setAsking] = useState(null)

  // Imported decks are studied individually; a bulk generate shouldn't write a
  // lecture for someone's Quizlet export.
  const unlocked = (domains || []).filter((d) => !d.is_imported_deck)

  // The server's judgement of where the work is needed, as a plain multiplier
  // per domain. Weak domains rate above 1, strong ones below.
  const need = Object.fromEntries(
    (performance?.domains || []).map((d) => [d.domain_id, needFrom(d)]),
  )
  const adaptive = Boolean(performance?.attempts)

  function generate(kind, values) {
    const cfg = GENERATORS[kind]
    setAsking(null)
    generation.start({
      moduleId,
      kind,
      label: cfg.label,
      run: async () => {
        const destination = await cfg.run(unlocked, values, adaptive ? need : null)
        for (const key of ['studio', 'module', 'module-stats', 'performance']) {
          queryClient.invalidateQueries({ queryKey: [key, moduleId] })
        }
        return destination
      },
    })
  }

  if (!unlocked.length) return null

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 border-l-2 border-accent pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
        <Sparkles size={13} aria-hidden="true" />
        Generate across every domain
      </h2>
      {adaptive && (
        <p className="px-1 text-xs text-sec">
          Weighted towards the domains you&rsquo;re finding hardest.
        </p>
      )}
      <div className="space-y-2">
        {Object.entries(GENERATORS).map(([kind, cfg]) => {
          const running = generation.isGenerating(moduleId, kind)
          return (
            <button
              key={kind}
              onClick={() => setAsking(kind)}
              disabled={running}
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
        onGenerate={(values) => {
          if (!unlocked.length) {
            toast.error('This module has no domains to generate for yet.')
            return
          }
          generate(asking, values)
        }}
      />
    </section>
  )
}

/**
 * How much extra a domain has earned, mirroring the server's own rule.
 *
 * Kept in step with `performance.need_multiplier` deliberately rather than
 * shipped down the wire: the allocation is arithmetic the learner can see the
 * result of, and a number that arrives pre-computed is one nobody can check.
 */
function needFrom(entry) {
  const score = entry?.internal
  if (score == null) return 1
  let multiplier = score >= 80 ? 0.5 : score >= 60 ? 1 : score >= 40 ? 1.5 : 2
  if (entry.regressed) multiplier *= 1.25
  return multiplier
}
