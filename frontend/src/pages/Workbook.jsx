import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ClipboardList, Layers, Loader2, Mic, Plus, Target,
} from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'

import AddSourceSheet from '../components/module/AddSourceSheet'
import ContainerSection from '../components/module/ContainerSection'
import MediaItemRow from '../components/module/MediaItemRow'
import SectionHeading from '../components/module/SectionHeading'
import SessionHistory from '../components/module/SessionHistory'
import SourcesTab from '../components/module/SourcesTab'
import PageTitle from '../components/PageTitle'
import { useGeneration } from '../hooks/useGeneration'
import { usePreferences } from '../hooks/usePreferences'
import { useToast } from '../hooks/useToast'
import { ApiError, api } from '../lib/api'
import * as lectures from '../lib/lectures'
import { path } from '../routes'
import { useState } from 'react'

/**
 * A workbook: material studied as itself.
 *
 * Structurally it is a module with one hidden domain and no blueprint — that
 * is what makes every module-scoped behaviour (missed questions, flagging,
 * drilling, graduation, history, soft removal) identical by construction
 * rather than by promise. This screen is where the difference lives: no
 * domains, no weights, no readiness-against-a-blueprint. Sources at the top,
 * what they became underneath, and the same containers a module has.
 *
 * Generation is aimed at the single domain, which holds everything, so
 * "generate a quiz from this workbook" and "generate a quiz from this domain"
 * are the same call.
 */
export default function Workbook() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const [showAdd, setShowAdd] = useState(false)

  const { data: module, isPending, error } = useQuery({
    queryKey: ['module', id],
    queryFn: ({ signal }) => api.module(id, signal),
  })
  const { data: sources } = useQuery({
    queryKey: ['sources', id],
    queryFn: ({ signal }) => api.sources(id, signal),
  })
  const { data: media } = useQuery({
    queryKey: ['studio', id],
    queryFn: ({ signal }) => api.studioMedia(id, signal),
  })

  // The one domain everything hangs off. A workbook is created with it, so
  // its absence means the row is still arriving, not that something broke.
  const domain = (module?.domains || []).find((d) => !d.is_imported_deck)

  if (isPending) {
    return (
      <div className="space-y-4 p-1">
        <div className="skeleton h-7 w-56" />
        <div className="skeleton h-40 rounded-2xl" />
      </div>
    )
  }
  if (error) {
    const isAuth = error instanceof ApiError && error.isAuth
    return (
      <p className="card text-center text-sm text-sec">
        {isAuth ? 'Sign in to open this workbook.' : 'That workbook could not be opened.'}
      </p>
    )
  }

  return (
    <div className="space-y-8">
      <PageTitle
        onBack={() => navigate(-1)}
        subtitle={`Workbook · ${(sources || []).length} source${
          (sources || []).length === 1 ? '' : 's'
        }`}
        actions={
          <button onClick={() => setShowAdd(true)} className="btn-secondary">
            <Plus size={16} aria-hidden="true" />
            Add material
          </button>
        }
      >
        {module?.title || 'Workbook'}
      </PageTitle>

      <AddSourceSheet
        open={showAdd}
        moduleId={id}
        onClose={() => setShowAdd(false)}
        onError={(m) => toast.error(m)}
      />

      {/* Everything below is built from exactly what lands here. */}
      <section className="space-y-3">
        <SectionHeading>Material</SectionHeading>
        <SourcesTab moduleId={id} sources={sources || []} />
      </section>

      {domain && (
        <section className="space-y-3">
          <SectionHeading>Make something from it</SectionHeading>
          <div className="card space-y-2 p-3">
            {['lecture', 'flashcards', 'quiz', 'practice'].map((kind) => (
              <WorkbookGenerate
                key={kind}
                kind={kind}
                moduleId={id}
                domain={domain}
                media={media}
              />
            ))}
          </div>
        </section>
      )}

      {/* The same two containers a module has, behaving identically because
          they are the same code pointed at the same tables. */}
      <ContainerSection moduleId={id} container="missed" />
      <ContainerSection moduleId={id} container="qa" />

      <SessionHistory moduleId={id} />
    </div>
  )
}

const KINDS = {
  lecture: { Icon: Mic, label: 'Lecture', busy: 'Building the lecture…' },
  flashcards: { Icon: Layers, label: 'Flashcards', busy: 'Writing cards…' },
  quiz: { Icon: ClipboardList, label: 'Quiz', busy: 'Writing questions…' },
  practice: { Icon: Target, label: 'Practice questions', busy: 'Building practice…' },
}

/** One media type: what exists, and the way to make more. The same row shape
 *  the Classroom uses, aimed at the workbook's single domain. */
function WorkbookGenerate({ kind, moduleId, domain, media }) {
  const cfg = KINDS[kind]
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const generation = useGeneration()
  const { preferences } = usePreferences()
  const [open, setOpen] = useState(false)

  const items = (
    kind === 'lecture' ? media?.lectures
      : kind === 'flashcards' ? media?.flashcards
        : kind === 'quiz' ? (media?.quizzes || []).filter((q) => !q.is_review)
          : media?.practice
  ) || []
  const working = generation.isGenerating(moduleId, kind, domain.id)

  function build() {
    return generation.start({
      moduleId,
      domainId: domain.id,
      kind,
      label: cfg.label,
      run: async ({ signal } = {}) => {
        let destination
        if (kind === 'lecture') {
          const lecture = await api.generateLecture({
            domain_id: domain.id,
            voice: preferences.tutor_voice,
            length: preferences.lecture_length,
          }, signal)
          if (lecture?.id) {
            await lectures.waitForLecture(lecture.id)
            destination = path('lecture', { id: lecture.id })
          }
        } else if (kind === 'flashcards') {
          await api.generateFlashcards({ domain_id: domain.id, count: 20 }, signal)
          destination = path('flashcards', { domainId: domain.id })
        } else if (kind === 'quiz') {
          await api.generateQuiz({
            domain_id: domain.id,
            difficulty: preferences.quiz_difficulty,
            question_count: 10,
          }, signal)
          destination = path('quizzes', { domainId: domain.id })
        } else {
          await api.practiceQuestions(domain.id, {})
          destination = path('practiceMode', { domainId: domain.id })
        }
        queryClient.invalidateQueries({ queryKey: ['studio', moduleId] })
        setOpen(true)
        return destination
      },
    })
  }

  function openItem(item) {
    if (kind === 'lecture') navigate(path('lecture', { id: item.id }))
    else if (kind === 'flashcards') navigate(path('flashcards', { domainId: domain.id }))
    else if (kind === 'quiz') navigate(`${path('quizzes', { domainId: domain.id })}?quiz=${item.id}`)
    else navigate(path('practiceMode', { domainId: domain.id }))
  }

  return (
    <div className="rounded-xl bg-surface2/60">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={() => (items.length ? setOpen((v) => !v) : build())}
          disabled={working}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent2">
            {working ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <cfg.Icon size={15} aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-pri">
              {cfg.label}
              {items.length > 1 && (
                <span className="ml-1.5 text-xs font-normal text-sec">{items.length}</span>
              )}
            </span>
            <span className="block truncate text-xs text-sec">
              {working ? cfg.busy : items.length
                ? items.map((i) => i.title).filter(Boolean).join(', ')
                : 'None yet'}
            </span>
          </span>
        </button>
        {!working && (
          <button
            type="button"
            onClick={() => build()}
            aria-label={`Generate ${cfg.label.toLowerCase()}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg
                       text-accent2 transition-colors hover:bg-accent/10"
          >
            {items.length ? <Plus size={15} aria-hidden="true" />
              : <span className="text-xs font-medium">Generate</span>}
          </button>
        )}
      </div>
      {open && items.length > 0 && (
        <ul className="border-t border-border/60">
          {items.map((item) => (
            <MediaItemRow
              key={item.id || item.title}
              kind={kind === 'practice' ? 'practice' : kind}
              item={item}
              onOpen={openItem}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
