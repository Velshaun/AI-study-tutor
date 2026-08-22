import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Layers,
  Loader2,
  Mic,
  Plus,
  RotateCcw,
  Sparkles,
  Target,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useConfirm } from '../../hooks/useConfirm'
import { useGeneration } from '../../hooks/useGeneration'
import { usePreferences } from '../../hooks/usePreferences'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
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
import MediaItemRow from './MediaItemRow'

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
    plural: 'Lectures',
    busy: 'Building the lecture…',
  },
  flashcards: {
    Icon: Layers,
    label: 'Flashcards',
    plural: 'Flashcard decks',
    busy: 'Writing cards…',
  },
  quiz: {
    Icon: ClipboardList,
    label: 'Quiz',
    plural: 'Quizzes',
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
  return { lectures: [], flashcards: [], quizzes: [], practice: [] }
}

/** Everything generated, filed under the domain it was generated for. */
function groupByDomain(media) {
  const out = {}
  const bucket = (id) => {
    if (!id) return null
    if (!out[id]) out[id] = emptyMedia()
    return out[id]
  }

  // Everything is a list.
  //
  // This used to keep one of each — `slot.lecture = lecture` — which was the
  // whole of the one-per-domain limit: the data always held several, the
  // grouping threw them away. A ten-minute lecture is an introduction, and the
  // second one is the next part of the subject rather than a correction of the
  // first.
  //
  // Counts are `list.length` rather than a number carried alongside, so a row
  // reading "Lectures · 3" that opens to two entries is not a state this can
  // reach.
  for (const lecture of media?.lectures || []) {
    bucket(lecture.domain_id)?.lectures.push(lecture)
  }
  for (const deck of media?.flashcards || []) {
    bucket(deck.domain_id)?.flashcards.push(deck)
  }
  for (const quiz of media?.quizzes || []) {
    bucket(quiz.domain_id)?.quizzes.push(quiz)
  }
  for (const set of media?.practice || []) {
    bucket(set.domain_id)?.practice.push(set)
  }

  // Newest first inside every row: the thing most likely to be wanted is the
  // thing just made.
  for (const slot of Object.values(out)) {
    for (const key of ['lectures', 'flashcards', 'quizzes', 'practice']) {
      slot[key].sort((a, b) =>
        String(b.created_at || '').localeCompare(String(a.created_at || '')))
    }
  }
  return out
}

function DomainRow({
  moduleId, domain, ordinal, media, score, examCount, expanded, onToggle,
}) {
  const tone = statusOf(score)
  const counts = {
    lecture: media.lectures.length,
    // Cards across every deck of this domain — progress is about how much
    // material exists, not how many piles it is in.
    flashcards: media.flashcards.reduce((n, d) => n + (d.count || 0), 0),
    quizzes: media.quizzes.length,
    practice: media.practice.reduce((n, p) => n + (p.count || 0), 0),
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
            kind="lecture" moduleId={moduleId} domain={domain}
            items={media.lectures} examCount={examCount}
          />
          <MediaAction
            kind="flashcards" moduleId={moduleId} domain={domain}
            items={media.flashcards} examCount={examCount}
          />
          <MediaAction
            kind="quiz" moduleId={moduleId} domain={domain}
            items={media.quizzes} examCount={examCount}
          />
          <MediaAction
            kind="practice" moduleId={moduleId} domain={domain}
            items={media.practice} examCount={examCount}
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
 * One media type within a domain: how many there are, what they are called, and
 * a way into each.
 *
 * The generate call carries this domain's id, which is the whole of what
 * "scoped to that domain automatically" means — there is no assignment step to
 * forget because there is no assignment step.
 *
 * The row used to be a single button holding a single item, which is what made
 * the Classroom one-of-each: a second lecture had nowhere to be drawn, so
 * generation was written to reuse or overwrite instead. Now the row is a count
 * plus the names, and tapping it opens the list in place rather than navigating
 * away — the reason to look is usually to pick between two of them, and a
 * screen change to answer "which ones do I have" costs more than it tells.
 */
function MediaAction({ kind, moduleId, domain, items = [], examCount }) {
  const cfg = MEDIA[kind]
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { preferences } = usePreferences()
  const confirm = useConfirm()
  const generation = useGeneration()
  const [open, setOpen] = useState(false)

  // A lecture still being written counts towards the row — the learner asked
  // for it and wants to see it coming — but cannot be opened.
  const building = items.filter(
    (i) => kind === 'lecture' && !lectures.isReady(i.status),
  )
  const count = items.length
  const has = count > 0

  // Open the one that was tapped, not the type it belongs to.
  //
  // Decks and quizzes live on domain-scoped screens that list everything the
  // domain holds, which was right when a domain held one. Naming the item in
  // the query string keeps those screens as they are and still lands on the
  // thing the learner pointed at. Practice questions are genuinely one pool per
  // domain, so there is nothing to name.
  function openItem(item) {
    if (kind === 'lecture') {
      navigate(path('lecture', { id: item.id }))
    } else if (kind === 'flashcards') {
      const deck = item.title && item.id?.includes(':') ? item.id.split(':').slice(1).join(':') : ''
      navigate(
        path('flashcards', { domainId: domain.id }) +
          (deck ? `?deck=${encodeURIComponent(deck)}` : ''),
      )
    } else if (kind === 'quiz') {
      navigate(`${path('quizzes', { domainId: domain.id })}?quiz=${item.id}`)
    } else {
      navigate(path('practiceMode', { domainId: domain.id }))
    }
  }

  // Generation runs above the router, not in this component.
  //
  // It always survived navigation — the promise outlives the render — but the
  // *state* did not: `busy` was local, so walking back into the Classroom
  // mid-build showed a row identical to the one before the tap. Nothing
  // building, nothing pending, no reason to believe anything had happened. The
  // provider keys the job by where the result will land, so the row that will
  // hold it says so wherever the learner is.
  function build() {
    return generation.start({
      moduleId,
      domainId: domain.id,
      kind,
      label: `${cfg.label} for ${domain.title}`,
      run: async () => {
        let destination
        if (kind === 'lecture') {
          const lecture = await api.generateLecture({
            domain_id: domain.id,
            voice: preferences.tutor_voice,
            length: preferences.lecture_length,
          })
          // The endpoint answers before there is any audio; waiting is what
          // makes the "View" that follows tell the truth.
          if (lecture?.id) {
            await lectures.waitForLecture(lecture.id)
            destination = path('lecture', { id: lecture.id })
          }
        } else if (kind === 'flashcards') {
          await api.generateFlashcards({ domain_id: domain.id, count: 20 })
          destination = path('flashcards', { domainId: domain.id })
        } else if (kind === 'quiz') {
          await api.generateQuiz({
            domain_id: domain.id,
            difficulty: preferences.quiz_difficulty,
            question_count: 10,
          })
          destination = path('quizzes', { domainId: domain.id })
        } else {
          await api.practiceQuestions(domain.id, { count: examCount })
          destination = path('practiceMode', { domainId: domain.id })
        }
        queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
        queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
        // Open the list so the new one is visible where it landed, rather than
        // behind a row that still reads the same as before.
        setOpen(true)
        return destination
      },
    })
  }

  // Removing is a UI action. Nothing produced from an item goes with it —
  // the Q&A asked during a lecture, the questions missed in a quiz, the cards
  // flagged for review all stay, because they are a record of what the learner
  // did rather than a property of the thing they did it with. The server marks
  // the row; see `services/removal.py` for why that is not a delete.
  const remove = useMutation({
    mutationFn: (item) => {
      if (kind === 'lecture') return api.deleteLecture(item.id)
      if (kind === 'quiz') return api.deleteQuiz(item.id)
      if (kind === 'flashcards') {
        const deck = item.id?.includes(':')
          ? item.id.split(':').slice(1).join(':')
          : ''
        return api.deleteFlashcardDeck(domain.id, deck)
      }
      return api.deletePracticeSet(domain.id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      toast.success('Removed')
    },
    onError: (e) => toast.error(e?.message || 'Couldn’t remove that'),
  })

  async function confirmRemove(item) {
    const ok = await confirm({
      title: `Remove “${item.title}”?`,
      // Said plainly, because the word "remove" is not self-evidently
      // different from "delete" and the difference is the whole point.
      message:
        'It comes off this screen. Anything it produced — questions you '
        + 'missed, cards you flagged, anything you asked during it — stays.',
      confirmLabel: 'Remove',
    })
    if (ok) remove.mutate(item)
  }

  // Read from the provider, so it is true on every screen that draws this row
  // rather than only on the one that started it.
  const working = generation.isGenerating(moduleId, kind, domain.id)
  const failure = generation.failureOf(moduleId, kind, domain.id)

  // The names, comma-separated, on one line. Truncation is the browser's job —
  // `truncate` clips with an ellipsis at whatever width there is, which is the
  // only thing that stays right across a phone and a desktop. Wrapping was the
  // alternative and would push every other row down the screen.
  const preview = items.map((i) => i.title).filter(Boolean).join(', ')
  const subtitle = working
    ? cfg.busy
    : failure
      ? failure.message
      : !has
        ? 'None yet'
        : building.length
          ? `${preview} · ${building.length} still building`
          : preview

  return (
    <div className={`overflow-hidden rounded-xl ${
      failure ? 'border border-danger/40 bg-danger/5'
        : working ? 'border border-accent/40 bg-accent/5'
          : has ? 'bg-surface2' : 'border border-dashed border-border'
    }`}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={() => (has ? setOpen((v) => !v) : failure ? failure.retry() : build())}
          disabled={working}
          aria-expanded={has ? open : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
            failure ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent2'
          }`}>
            {working ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : failure ? (
              <AlertCircle size={15} aria-hidden="true" />
            ) : (
              <cfg.Icon size={15} aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-pri">
              {count > 1 ? cfg.plural || cfg.label : cfg.label}
              {/* Only when there is more than one. A "1" beside every row is
                  noise, and practice questions are one pool per domain by
                  design — the size of that pool belongs in the subtitle, not
                  in a badge claiming the domain holds one of something. */}
              {count > 1 && (
                <span className="ml-1.5 text-xs font-normal text-sec">{count}</span>
              )}
            </span>
            <span className={`block truncate text-xs ${
              failure ? 'text-danger' : working ? 'text-accent2' : 'text-sec'
            }`}>
              {subtitle}
            </span>
          </span>
          {has && !working && (
            <ChevronDown
              size={15}
              aria-hidden="true"
              className={`shrink-0 text-sec transition-transform ${open ? 'rotate-180' : ''}`}
            />
          )}
        </button>

        {/* Making another is one tap even once the list is long — accumulating
            is the point, so "add" cannot be buried inside the list it adds to.
            On an empty row the whole row already generates, so this is a label
            rather than a second button competing with it. */}
        {/* A failure stays put until it is retried or waved off. A toast is
            gone in four seconds and someone in another tab never saw it, so
            quietly reverting the row to "none yet" is how a failure becomes a
            mystery. */}
        {!working && failure ? (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => failure.retry()}
              aria-label={`Try building the ${cfg.label.toLowerCase()} again`}
              className="flex size-8 items-center justify-center rounded-lg
                         text-accent2 transition-colors hover:bg-accent/10"
            >
              <RotateCcw size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => generation.dismissFailure(moduleId, kind, domain.id)}
              aria-label="Dismiss this error"
              className="flex size-8 items-center justify-center rounded-lg
                         text-sec transition-colors hover:bg-surface2"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </span>
        ) : !working && (has ? (
          <button
            type="button"
            onClick={() => build()}
            aria-label={`Generate another ${cfg.label.toLowerCase()} for ${domain.title}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg
                       text-accent2 transition-colors hover:bg-accent/10"
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        ) : (
          <span className="shrink-0 pe-1 text-xs font-medium text-accent2">
            Generate
          </span>
        ))}
      </div>

      {open && has && (
        <ul className="border-t border-border/60">
          {items.map((item) => (
            <MediaItemRow
              key={item.id || item.title}
              kind={kind}
              item={item}
              onOpen={openItem}
              onRemove={confirmRemove}
            />
          ))}
        </ul>
      )}
    </div>
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
