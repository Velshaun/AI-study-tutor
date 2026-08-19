import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Layers,
  Loader2,
  Mic,
  Play,
  Sparkles,
  Target,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { usePreferences } from '../../hooks/usePreferences'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { formatClock } from '../../lib/format'
import * as lectures from '../../lib/lectures'
import {
  PROGRESS_COPY,
  displayScore,
  domainProgress,
  mediaSummary,
  sessionLabel,
  statusOf,
} from '../../lib/performance'
import { path } from '../../routes'

/**
 * The Classroom, organised the way the exam is: by domain.
 *
 * It used to be a pool grouped by media type — every lecture together, every
 * deck together — which is how the data happened to be shaped, not how anyone
 * revises. Nobody sits down to "do some flashcards"; they sit down to work on
 * subnetting, and want the lecture, the deck and the quiz for subnetting in one
 * place. Every generated item already carried its domain; nothing was grouping
 * by it.
 *
 * One domain at a time is expanded. Generating from inside a domain scopes to
 * that domain by construction — the generate call is made with that domain's
 * id, so there is nothing for a learner to assign and nothing to get wrong.
 *
 * Practice exams are not here. They span every domain at once, so they belong
 * above this list rather than inside any one row of it.
 */

const MEDIA = {
  lecture: {
    Icon: Mic,
    label: 'Lecture',
    busy: 'Building the lecture…',
  },
  flashcards: {
    Icon: Layers,
    label: 'Flashcards',
    busy: 'Writing cards…',
  },
  quiz: {
    Icon: ClipboardList,
    label: 'Quiz',
    busy: 'Writing questions…',
  },
  practice: {
    Icon: Target,
    label: 'Practice questions',
    busy: 'Building practice…',
  },
}

export default function DomainClassroom({
  moduleId, domains, media, performance, examCount,
}) {
  const [open, setOpen] = useState(null)
  const byDomain = groupByDomain(media)
  const scoreOf = Object.fromEntries(
    (performance?.domains || []).map((d) => [d.domain_id, d]),
  )

  const studyable = (domains || []).filter((d) => !d.is_imported_deck)
  const decks = (domains || []).filter((d) => d.is_imported_deck)

  if (!studyable.length && !decks.length) return null

  return (
    <section className="space-y-3">
      <Heading Icon={Sparkles}>Domains</Heading>
      <div className="space-y-2">
        {studyable.map((domain, index) => (
          <DomainRow
            key={domain.id}
            moduleId={moduleId}
            domain={domain}
            // "Topic 2: …" — the position on the blueprint is part of how a
            // certification names its own domains, so it is part of the label.
            ordinal={index + 1}
            media={byDomain[domain.id] || emptyMedia()}
            score={scoreOf[domain.id]}
            examCount={examCount}
            expanded={open === domain.id}
            onToggle={() => setOpen((cur) => (cur === domain.id ? null : domain.id))}
          />
        ))}
        {decks.map((domain) => (
          <DomainRow
            key={domain.id}
            moduleId={moduleId}
            domain={domain}
            media={byDomain[domain.id] || emptyMedia()}
            score={scoreOf[domain.id]}
            examCount={examCount}
            expanded={open === domain.id}
            onToggle={() => setOpen((cur) => (cur === domain.id ? null : domain.id))}
          />
        ))}
      </div>
    </section>
  )
}

function emptyMedia() {
  return { lecture: null, flashcards: null, quizzes: [], practice: null }
}

/** Everything generated, filed under the domain it was generated for. */
function groupByDomain(media) {
  const out = {}
  const bucket = (id) => {
    if (!id) return null
    if (!out[id]) out[id] = emptyMedia()
    return out[id]
  }

  for (const lecture of media?.lectures || []) {
    const slot = bucket(lecture.domain_id)
    // A ready lecture always beats one still being built, so an expanded domain
    // offers the finished thing rather than the spinner beside it.
    if (slot && (!slot.lecture || lectures.isReady(lecture.status))) {
      slot.lecture = lecture
    }
  }
  for (const deck of media?.flashcards || []) {
    const slot = bucket(deck.domain_id)
    if (slot) slot.flashcards = deck
  }
  for (const quiz of media?.quizzes || []) {
    bucket(quiz.domain_id)?.quizzes.push(quiz)
  }
  for (const set of media?.practice || []) {
    const slot = bucket(set.domain_id)
    if (slot) slot.practice = set
  }
  return out
}

function DomainRow({
  moduleId, domain, ordinal, media, score, examCount, expanded, onToggle,
}) {
  const tone = statusOf(score)
  const counts = {
    lecture: Boolean(media.lecture),
    flashcards: media.flashcards?.count || 0,
    quizzes: media.quizzes.length,
    practice: media.practice?.count || 0,
  }
  const progress = domainProgress(score, counts)
  const label = ordinal ? `Topic ${ordinal}: ${domain.title}` : domain.title

  return (
    <div className="card space-y-0 p-0">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-pri">
              {label}
            </span>
            {progress === 'complete' && (
              <CheckCircle2 size={15} className="shrink-0 text-success" aria-hidden="true" />
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-sec">
            {domain.weight_pct ? (
              <span>{Math.round(domain.weight_pct)}% of exam</span>
            ) : domain.is_imported_deck ? (
              <span>Imported deck</span>
            ) : null}
            <span aria-hidden="true">·</span>
            <span>{PROGRESS_COPY[progress]}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{mediaSummary(counts)}</span>
          </span>
        </span>

        <Strength score={score} tone={tone} />
        <ChevronDown
          size={18}
          className={`mt-0.5 shrink-0 text-sec transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-border p-4 pt-3">
          {score?.note && (
            <p className="rounded-xl bg-surface2 px-3 py-2 text-xs leading-relaxed text-sec">
              {score.note}
            </p>
          )}
          <MediaAction
            kind="lecture" moduleId={moduleId} domain={domain} item={media.lecture}
            examCount={examCount}
          />
          <MediaAction
            kind="flashcards" moduleId={moduleId} domain={domain}
            item={media.flashcards} examCount={examCount}
          />
          <MediaAction
            kind="quiz" moduleId={moduleId} domain={domain}
            item={media.quizzes[0]} examCount={examCount}
          />
          <MediaAction
            kind="practice" moduleId={moduleId} domain={domain}
            item={media.practice} examCount={examCount}
          />
        </div>
      )}
    </div>
  )
}

/**
 * The rolling score, with today's result underneath it.
 *
 * Two numbers rather than one, and the smaller one is today's. Somebody who has
 * been getting 70% for a fortnight and scores 43% this evening has had a bad
 * evening — the big number should say so quietly and the small one plainly.
 */
function Strength({ score, tone }) {
  if (!score || score.display == null) {
    return (
      <span className="shrink-0 rounded-full bg-surface2 px-2 py-0.5 text-[11px] font-medium text-sec">
        —
      </span>
    )
  }
  const session = sessionLabel(score)
  return (
    <span className="shrink-0 text-right">
      <span className={`block text-sm font-semibold tabular-nums ${tone.text}`}>
        {displayScore(score)}
      </span>
      {session && (
        <span className="block text-[11px] text-sec">
          {Math.round(score.session)}% {session}
        </span>
      )}
    </span>
  )
}

/**
 * One media type within a domain: open it, or make it.
 *
 * The generate call carries this domain's id, which is the whole of what
 * "scoped to that domain automatically" means — there is no assignment step to
 * forget because there is no assignment step.
 */
function MediaAction({ kind, moduleId, domain, item, examCount }) {
  const cfg = MEDIA[kind]
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { preferences } = usePreferences()
  const [busy, setBusy] = useState(false)

  const lectureBuilding =
    kind === 'lecture' && item && !lectures.isReady(item.status)
  const exists = Boolean(item) && !lectureBuilding

  function openIt() {
    if (kind === 'lecture') navigate(path('lecture', { id: item.id }))
    else if (kind === 'flashcards') navigate(path('flashcards', { domainId: domain.id }))
    else if (kind === 'quiz') navigate(path('quizzes', { domainId: domain.id }))
    else navigate(path('practiceMode', { domainId: domain.id }))
  }

  const build = useMutation({
    mutationFn: async () => {
      if (kind === 'lecture') {
        const lecture = await api.generateLecture({
          domain_id: domain.id,
          voice: preferences.tutor_voice,
          length: preferences.lecture_length,
        })
        // The endpoint answers before there is any audio; waiting is what makes
        // the "Open" that follows tell the truth.
        if (lecture?.id) await lectures.waitForLecture(lecture.id)
        return lecture
      }
      if (kind === 'flashcards') {
        return api.generateFlashcards({ domain_id: domain.id, count: 20 })
      }
      if (kind === 'quiz') {
        return api.generateQuiz({
          domain_id: domain.id,
          difficulty: preferences.quiz_difficulty,
          question_count: 10,
        })
      }
      return api.practiceQuestions(domain.id, { count: examCount })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      toast.success(`${cfg.label} ready for ${domain.title}`)
    },
    onError: (e) =>
      toast.error(e?.message || `Couldn’t build the ${cfg.label.toLowerCase()}`),
    onSettled: () => setBusy(false),
  })

  const working = busy || build.isPending || lectureBuilding
  const subtitle = lectureBuilding
    ? lectures.generatingLabel(item.status)
    : kind === 'lecture' && item?.duration_secs
      ? formatClock(item.duration_secs)
      : kind === 'flashcards' && item?.count
        ? `${item.count} cards`
        : kind === 'quiz' && item
          ? `${item.question_count} questions${
              item.score != null ? ` · last ${Math.round(item.score)}%` : ''
            }`
          : kind === 'practice' && item?.count
            ? `${item.count} questions`
            : 'Not generated yet'

  return (
    <button
      onClick={() => {
        if (working) return
        if (exists) return openIt()
        setBusy(true)
        build.mutate()
      }}
      disabled={working}
      aria-busy={working}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
        working
          ? 'bg-surface2 opacity-70'
          : exists
            ? 'bg-surface2 hover:bg-surface2/70'
            : 'border border-dashed border-border hover:border-accent/50'
      }`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent2">
        {working ? (
          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
        ) : (
          <cfg.Icon size={15} aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-pri">{cfg.label}</span>
        <span className="block truncate text-xs text-sec">
          {working && !lectureBuilding ? cfg.busy : subtitle}
        </span>
      </span>
      {!working &&
        (exists ? (
          kind === 'lecture' ? (
            <Play size={15} className="shrink-0 text-accent2" aria-hidden="true" />
          ) : (
            <BookOpen size={15} className="shrink-0 text-accent2" aria-hidden="true" />
          )
        ) : (
          <span className="shrink-0 text-xs font-medium text-accent2">Generate</span>
        ))}
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
