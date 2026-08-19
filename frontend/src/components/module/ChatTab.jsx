import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  Check,
  ClipboardCheck,
  FileText,
  Globe,
  Loader2,
  Plus,
  ScanSearch,
  Search,
  Send,
  ThumbsDown,
  Trash2,
  Video,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'

/**
 * Chat tab — the module's tutor.
 *
 * It knows what the learner uploaded and what the exam covers, so it can answer
 * from their own material, find free study resources, and — the thing it exists
 * for — say whether what they've uploaded is actually enough to pass, domain by
 * domain and weighted by what the paper asks.
 *
 * The conversation persists server-side. It used to live in React state, which
 * meant switching tab threw it away; a tutor that forgets what you just asked
 * isn't one.
 *
 * Everything is AI-generated, hence the standing disclaimer under the input.
 */

const TYPE_ICON = {
  youtube: Video,
  pdf: FileText,
  docs: BookOpen,
  website: Globe,
}

const COVERAGE = {
  well_covered: { label: 'Well covered', tone: 'text-success', bar: 'bg-success' },
  partial: { label: 'Partial', tone: 'text-warning', bar: 'bg-warning' },
  missing: { label: 'Missing', tone: 'text-warning', bar: 'bg-warning' },
}

const READINESS_COPY = {
  ready: 'Your material covers this exam.',
  mostly_ready: 'Close — a few gaps worth filling.',
  significant_gaps: 'There are real gaps to fill.',
}

const DEPTH_COPY = {
  thorough: 'taught in depth',
  overview: 'explained',
  mention: 'mentioned only',
}

const ASSESS_PROMPT = 'Is the material I uploaded sufficient for this exam?'

// How often to ask whether the sources have finished being read. Reading a
// large pack is minutes of work, so this is a check-in, not a spinner.
const COVERAGE_POLL_MS = 4000

export default function ChatTab({ moduleId }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [input, setInput] = useState('')
  const [added, setAdded] = useState(() => new Set())
  const [reported, setReported] = useState(() => new Set())
  const endRef = useRef(null)

  const { data: history, isPending } = useQuery({
    queryKey: ['tutor', moduleId],
    queryFn: ({ signal }) => api.tutorHistory(moduleId, signal),
  })
  const messages = Array.isArray(history) ? history : []

  // The coverage map: what every source covers, from reading all of them. An
  // assessment waits on it, so its state is worth showing rather than hiding
  // behind a long spinner.
  const { data: coverage } = useQuery({
    queryKey: ['coverage', moduleId],
    queryFn: ({ signal }) => api.coverage(moduleId, signal),
    refetchInterval: (query) =>
      query.state.data?.status === 'computing' ? COVERAGE_POLL_MS : false,
    refetchIntervalInBackground: false,
  })
  const analysing = coverage?.status === 'computing'

  const ask = useMutation({
    mutationFn: ({ question, forceAssessment, resumeMessageId }) =>
      api.askTutor(moduleId, question, { forceAssessment, resumeMessageId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tutor', moduleId] })
      // Asking for an assessment can start the sources being read, so the map's
      // state has probably just changed.
      queryClient.invalidateQueries({ queryKey: ['coverage', moduleId] })
      endRef.current?.scrollIntoView({ behavior: 'smooth' })
    },
    onError: (e) => toast.error(e?.message || 'The tutor could not answer.'),
  })

  // An assessment asked for before the sources had been read leaves a placeholder
  // saying so. When the read lands, finish what the learner already asked for —
  // making them tap again to receive an answer they requested is a worse tab.
  //
  // The guard is a ref, not state: StrictMode replays state updaters, and a
  // replayed dedupe is no dedupe at all.
  const { mutate: askMutate } = ask
  const last = messages[messages.length - 1]
  const pendingAssessmentId =
    last?.kind === 'assessment' && last?.payload?.status === 'computing'
      ? last.id
      : null
  const resumed = useRef(null)
  useEffect(() => {
    if (!pendingAssessmentId || resumed.current === pendingAssessmentId) return
    if (coverage?.status !== 'ready' || coverage?.stale) return
    resumed.current = pendingAssessmentId
    askMutate({
      question: ASSESS_PROMPT,
      forceAssessment: true,
      resumeMessageId: pendingAssessmentId,
    })
  }, [pendingAssessmentId, coverage?.status, coverage?.stale, askMutate])

  const clear = useMutation({
    mutationFn: () => api.clearTutor(moduleId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tutor', moduleId] }),
  })

  const add = useMutation({
    mutationFn: async (url) => {
      await api.addLink(moduleId, url)
      await api.processModule(moduleId)
    },
    onSuccess: (_data, url) => {
      setAdded((prev) => new Set(prev).add(url))
      queryClient.invalidateQueries({ queryKey: ['sources', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      toast.success('Added to sources — reprocessing your module…')
    },
    onError: (e) => toast.error(e?.message || 'Could not add that source.'),
  })

  const report = useMutation({
    mutationFn: (url) => api.reportDeadLink(moduleId, url),
    onSuccess: (_data, url) => {
      setReported((prev) => new Set(prev).add(url))
      toast.success('Thanks — that one won’t come back')
    },
    onError: (e) => toast.error(e?.message || 'Could not report that link.'),
  })

  function submit(e) {
    e.preventDefault()
    const question = input.trim()
    if (!question || ask.isPending) return
    setInput('')
    ask.mutate({ question })
  }

  return (
    <div className="space-y-4">
      {/* Assess — the question this tab exists to answer, one tap away. */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => ask.mutate({ question: ASSESS_PROMPT, forceAssessment: true })}
          disabled={ask.isPending}
          className="btn-secondary flex-1"
        >
          <ClipboardCheck size={16} aria-hidden="true" />
          Assess my material
        </button>
        {messages.length > 0 && (
          <button
            onClick={() => clear.mutate()}
            aria-label="Clear conversation"
            className="btn-ghost size-10 shrink-0 rounded-full p-0"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {isPending ? (
        <div className="space-y-2">
          <div className="skeleton h-16 rounded-2xl" />
          <div className="skeleton h-16 rounded-2xl" />
        </div>
      ) : messages.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-center">
          <Search size={24} className="text-sec" aria-hidden="true" />
          <p className="mx-auto max-w-xs text-sm text-sec">
            Ask about anything in this module, or whether what you&rsquo;ve
            uploaded is enough for the exam. I can find free study material too.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {messages.map((m) =>
            m.role === 'user' ? (
              <div
                key={m.id}
                className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-surface2 px-4 py-2.5 text-sm text-pri"
              >
                {m.content}
              </div>
            ) : (
              <div key={m.id} className="space-y-3">
                {m.kind === 'assessment' ? (
                  m.payload?.status === 'computing' ? (
                    <Analysing coverage={coverage} />
                  ) : (
                    <Assessment assessment={m.payload} />
                  )
                ) : m.kind === 'resources' ? (
                  <>
                    {(m.payload?.resources || [])
                      .filter((r) => !reported.has(r.url))
                      .map((r, i) => (
                        <ResourceCard
                          key={`${m.id}-${i}`}
                          resource={r}
                          added={added.has(r.url)}
                          pending={add.isPending && add.variables === r.url}
                          reporting={report.isPending && report.variables === r.url}
                          onAdd={() => add.mutate(r.url)}
                          onReport={() => report.mutate(r.url)}
                        />
                      ))}
                    {m.content && <Bubble>{m.content}</Bubble>}
                    {!m.content && !(m.payload?.resources || []).length && (
                      <p className="text-sm text-sec">
                        Nothing freely accessible came back — try rephrasing.
                      </p>
                    )}
                  </>
                ) : (
                  <Bubble>{m.content}</Bubble>
                )}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
      )}

      {ask.isPending && (
        <div className="flex items-center gap-2.5 rounded-2xl bg-surface px-4 py-3">
          <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
          <span className="text-sm text-sec">Thinking…</span>
        </div>
      )}

      {/* Reading a large pack takes minutes, and it happens whether or not the
          learner is looking at this tab. Saying so beats an assessment that
          arrives late with no explanation for the wait. */}
      {analysing && !pendingAssessmentId && (
        <div className="flex items-center gap-2.5 rounded-2xl bg-surface px-4 py-3">
          <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
          <span className="text-sm text-sec">Analysing your sources…</span>
        </div>
      )}

      <form onSubmit={submit} className="space-y-2">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask your tutor anything…"
            className="input flex-1"
          />
          <button
            type="submit"
            disabled={!input.trim() || ask.isPending}
            className="btn-primary px-4"
          >
            <Send size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="text-xs text-sec">
          Answers are AI-generated from your sources. Always verify.
        </p>
      </form>
    </div>
  )
}

function Bubble({ children }) {
  return (
    <div className="rounded-2xl rounded-bl-sm border border-accent/25 bg-surface px-4 py-3">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-pri">{children}</p>
    </div>
  )
}

/**
 * The assessment is waiting on the sources being read.
 *
 * Shown instead of a bare spinner because the wait is real work with a
 * knowable size — and because an assessment that arrived instantly is exactly
 * the sampled guess this replaced.
 */
function Analysing({ coverage }) {
  const failed = coverage?.status === 'failed'
  return (
    <div className="card space-y-2">
      <div className="flex items-center gap-2.5">
        {failed ? (
          <ScanSearch size={16} className="text-warning" aria-hidden="true" />
        ) : (
          <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
        )}
        <p className="text-sm font-semibold text-pri">
          {failed ? 'Couldn’t finish reading your sources' : 'Reading your sources'}
        </p>
      </div>
      <p className="text-xs leading-relaxed text-sec">
        {failed
          ? coverage?.error ||
            'Something went wrong part-way through. Try asking again.'
          : 'Every source is being read in full and matched against the exam ' +
            'blueprint, so the assessment covers all of it rather than a ' +
            'sample. Your answer appears here when it’s done — you can leave ' +
            'this tab.'}
      </p>
    </div>
  )
}

/** The material assessment: the verdict, then the evidence behind it. */
export function Assessment({ assessment }) {
  const domains = assessment?.domains || []
  const covered = assessment?.covered_pct ?? 0

  return (
    <div className="card space-y-4">
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-semibold text-pri">
            {READINESS_COPY[assessment?.readiness] || 'Material assessment'}
          </p>
          <p className="shrink-0 text-sm font-semibold tabular-nums text-accent2">
            {Math.round(covered)}%
          </p>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${Math.min(100, covered)}%` }}
          />
        </div>
        <p className="text-xs text-sec">
          of the exam&rsquo;s weight covered by your {assessment?.source_count || 0}{' '}
          source{assessment?.source_count === 1 ? '' : 's'}
        </p>
      </div>

      {assessment?.verdict && (
        <p className="text-sm leading-relaxed text-pri">{assessment.verdict}</p>
      )}

      {domains.length > 0 && (
        <div className="space-y-2">
          {domains.map((d) => {
            const tone = COVERAGE[d.coverage] || COVERAGE.partial
            return (
              <div key={d.title} className="space-y-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm text-pri">{d.title}</p>
                  <p className={`shrink-0 text-xs font-medium ${tone.tone}`}>
                    {tone.label}
                    {d.weight_pct ? ` · ${Math.round(d.weight_pct)}%` : ''}
                  </p>
                </div>
                <p className="text-xs leading-relaxed text-sec">{d.note}</p>
                {/* Which files a domain came from, so a gap can be traced back
                    to what was uploaded rather than taken on trust. */}
                {d.sources?.length > 0 && (
                  <p className="truncate text-xs text-sec/70">
                    {DEPTH_COPY[d.depth] ? `${DEPTH_COPY[d.depth]} · ` : ''}
                    {d.sources.join(', ')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {assessment?.gaps?.length > 0 && (
        <Section label="Gaps">
          {assessment.gaps.map((g) => (
            <li key={g} className="text-sm text-pri">
              {g}
            </li>
          ))}
        </Section>
      )}

      {assessment?.recommendations?.length > 0 && (
        <Section label="What to do next">
          {assessment.recommendations.map((r) => (
            <li key={r} className="text-sm text-pri">
              {r}
            </li>
          ))}
        </Section>
      )}

      <Provenance analysis={assessment?.analysis} />
    </div>
  )
}

/**
 * How the material was read.
 *
 * The whole point of the coverage map is that nothing was skipped, which is
 * invisible unless it's said. And where something *was* skipped — a pack past
 * the reader's ceiling, or an old sampled assessment — that has to be said
 * louder, not quieter.
 */
function Provenance({ analysis }) {
  if (!analysis) return null
  const chars = Number(analysis.chars_analysed || 0).toLocaleString()

  if (analysis.mode !== 'full') {
    return (
      <p className="border-t border-border pt-3 text-xs text-sec">
        Based on a {chars}-character sample of your sources.
      </p>
    )
  }

  return (
    <p className="border-t border-border pt-3 text-xs text-sec">
      Read {chars} characters across {analysis.chunk_count} passage
      {analysis.chunk_count === 1 ? '' : 's'} of your sources.
      {analysis.truncated
        ? ' Your material was larger than one pass could read, so the tail of' +
          ' the largest file wasn’t included.'
        : ''}
    </p>
  )
}

function Section({ label, children }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wider text-sec">{label}</p>
      <ul className="list-disc space-y-1 pl-5 marker:text-accent2">{children}</ul>
    </div>
  )
}

function ResourceCard({ resource, added, pending, reporting, onAdd, onReport }) {
  const Icon = TYPE_ICON[resource.type] || Globe
  let host = resource.url
  try {
    host = new URL(resource.url).hostname.replace(/^www\./, '')
  } catch {
    /* keep the raw url */
  }

  return (
    <div className="card flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
        <Icon size={18} aria-hidden="true" />
      </span>
      <a href={resource.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-pri">{resource.title}</p>
        <p className="truncate text-xs text-sec">{host}</p>
      </a>
      {added ? (
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-success">
          <Check size={14} aria-hidden="true" />
          Added
        </span>
      ) : (
        <button
          onClick={onAdd}
          disabled={pending}
          className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
        >
          {pending ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Plus size={13} aria-hidden="true" />
          )}
          Add to Sources
        </button>
      )}
      <button
        onClick={onReport}
        disabled={reporting}
        title="Broken or paywalled? Report it and it won't come back"
        aria-label={`Report ${resource.title} as broken`}
        className="shrink-0 rounded-lg p-2 text-sec transition-colors hover:bg-surface2 hover:text-warning"
      >
        {reporting ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <ThumbsDown size={14} aria-hidden="true" />
        )}
      </button>
    </div>
  )
}
