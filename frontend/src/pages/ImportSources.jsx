import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ClipboardList,
  FileText,
  Layers,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  Video,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import PageTitle from '../components/PageTitle'
import { useJobs } from '../hooks/useJobs'
import { useToast } from '../hooks/useToast'
import { api } from '../lib/api'
import { path } from '../routes'

/**
 * Import study material by pasting it.
 *
 * Its own screen rather than a fourth tab on the add-source sheet: staging
 * several sources, correcting their labels and reading back what each one
 * became needs more room than a sheet has, and this is a sit-down task rather
 * than a one-tap one.
 *
 * The shape of it is stage-then-commit. Paste something, label it, add it to a
 * list, repeat — then one Import All sends the batch as a single job. That
 * matters for a reason the UI doesn't show: a multi-source import rebuilds the
 * module's study plan exactly once at the end, not once per source.
 *
 * The label is the learner's. Pasting runs a detection pass that pre-selects a
 * pill and, where the two disagree, says so before anything is imported — a
 * list of terms and definitions cannot become a gradeable exam however it is
 * labelled, and finding that out afterwards is worse than being told now.
 */

const TYPES = [
  { id: 'reference', label: 'Study material', Icon: FileText,
    hint: 'Notes, transcripts, captions — anything to learn from.' },
  { id: 'flashcards', label: 'Flashcards', Icon: Layers,
    hint: 'Term and definition pairs, like a Quizlet export.' },
  { id: 'quiz', label: 'Quiz', Icon: ClipboardList,
    hint: 'Questions with options and an answer key.' },
  { id: 'practice_exam', label: 'Practice exam', Icon: ClipboardList,
    hint: 'A full past paper with options and answers.' },
]

/** What the parser said it would become, in the learner's words. */
const OUTCOME = {
  questions: 'a sittable exam',
  flashcards: 'a flashcard deck',
  reference: 'study material',
}

export default function ImportSources() {
  const { id: moduleId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { forModule } = useJobs()

  const [text, setText] = useState('')
  const [type, setType] = useState('reference')
  const [title, setTitle] = useState('')
  const [staged, setStaged] = useState([])
  const [suggestion, setSuggestion] = useState(null)

  const running = forModule(moduleId)

  const { data: history } = useQuery({
    queryKey: ['import-jobs', moduleId],
    queryFn: ({ signal }) => api.importJobs(moduleId, signal),
    // While something is in flight the Realtime provider already knows, but the
    // per-item detail lives on the API — so poll only while it matters.
    refetchInterval: running.length ? 3000 : false,
  })

  /** Ask what the paste looks like, to pre-select a pill. Never overrides. */
  const detect = useMutation({
    mutationFn: (value) => api.detectImport(value),
    onSuccess: (res) => {
      setSuggestion(res)
      // Only moves the pill if the learner hasn't chosen one themselves yet.
      if (type === 'reference' && res.detected && res.detected !== 'reference') {
        setType(res.detected)
      }
    },
  })

  function onPaste(value) {
    setText(value)
    setSuggestion(null)
    if (value.trim().length > 40) detect.mutate(value)
  }

  function add() {
    const body = text.trim()
    if (!body) return
    setStaged((list) => [
      ...list,
      {
        key: `${Date.now()}-${list.length}`,
        title: title.trim() || `Pasted source ${list.length + 1}`,
        content_type: type,
        text: body,
        chars: body.length,
        wouldBe: suggestion?.would_be ?? null,
      },
    ])
    setText('')
    setTitle('')
    setType('reference')
    setSuggestion(null)
  }

  const importAll = useMutation({
    mutationFn: () =>
      api.importPaste(moduleId, staged.map(({ title: t, content_type, text: body }) => ({
        title: t, content_type, text: body,
      }))),
    onSuccess: (job) => {
      setStaged([])
      queryClient.invalidateQueries({ queryKey: ['import-jobs', moduleId] })
      toast.success(
        `Importing ${job.total_items} source${job.total_items === 1 ? '' : 's'} — ` +
        'you can leave this screen.',
      )
    },
    onError: (e) => toast.error(e?.message || 'Could not start that import.'),
  })

  const retry = useMutation({
    mutationFn: (jobId) => api.retryImport(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-jobs', moduleId] })
      toast.success('Retrying the ones that didn’t work.')
    },
    onError: (e) => toast.error(e?.message || 'Nothing to retry.'),
  })

  return (
    <div className="space-y-6">
      <PageTitle
        onBack={() => navigate(path('module', { id: moduleId }))}
        backLabel="Back to module"
        subtitle="Paste exported flashcards, captions, past papers or notes."
      >
        Import material
      </PageTitle>

      <YouTubeDoor moduleId={moduleId} />

      {/* --- paste --------------------------------------------------------- */}
      <section className="card space-y-3">
        <textarea
          value={text}
          onChange={(e) => onPaste(e.target.value)}
          rows={8}
          placeholder="Paste here — a Quizlet export, a downloaded caption file, a past paper…"
          className="input min-h-40 w-full resize-y font-mono text-xs"
        />

        <div className="flex flex-wrap gap-2">
          {TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => setType(t.id)}
              aria-pressed={type === t.id}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs
                          font-medium transition-colors ${
                            type === t.id
                              ? 'bg-accent text-white'
                              : 'bg-surface2 text-sec hover:text-pri'
                          }`}
            >
              <t.Icon size={14} aria-hidden="true" />
              {t.label}
            </button>
          ))}
        </div>

        <p className="text-xs text-sec">
          {detect.isPending
            ? 'Looking at what you pasted…'
            : TYPES.find((t) => t.id === type)?.hint}
        </p>

        {/* Where the label and the material disagree, say so now. */}
        {suggestion && text.trim() && (
          <Disagreement type={type} suggestion={suggestion} />
        )}

        <div className="flex gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Name it (optional)"
            className="input flex-1"
          />
          <button onClick={add} disabled={!text.trim()} className="btn-secondary px-4">
            <Plus size={16} aria-hidden="true" />
            Add
          </button>
        </div>
      </section>

      {/* --- staged -------------------------------------------------------- */}
      {staged.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 border-l-2 border-accent pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
            Ready to import ({staged.length})
          </h2>
          <div className="space-y-2">
            {staged.map((s, i) => (
              <div key={s.key} className="card flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-pri">{s.title}</p>
                  <p className="text-xs text-sec">
                    {s.chars.toLocaleString()} characters
                  </p>
                </div>
                {/* Labels stay correctable right up to the moment of import. */}
                <select
                  value={s.content_type}
                  onChange={(e) =>
                    setStaged((list) =>
                      list.map((x, n) =>
                        n === i ? { ...x, content_type: e.target.value } : x,
                      ),
                    )
                  }
                  className="input shrink-0 py-1.5 text-xs"
                  aria-label={`Content type for ${s.title}`}
                >
                  {TYPES.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => setStaged((list) => list.filter((_, n) => n !== i))}
                  aria-label={`Remove ${s.title}`}
                  className="btn-ghost size-10 shrink-0 rounded-full p-0 hover:text-warning"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={() => importAll.mutate()}
            disabled={importAll.isPending}
            className="btn-primary w-full"
          >
            {importAll.isPending ? (
              <>
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                Starting…
              </>
            ) : (
              <>
                <Upload size={16} aria-hidden="true" />
                Import all {staged.length}
              </>
            )}
          </button>
          <p className="text-center text-xs text-sec">
            Your study plan rebuilds once at the end, not once per source.
          </p>
        </section>
      )}

      {/* --- what happened ------------------------------------------------- */}
      {(history || []).length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 border-l-2 border-accent pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
            Imports
          </h2>
          {history.map((job) => (
            <ImportRow key={job.id} job={job} onRetry={() => retry.mutate(job.id)} />
          ))}
        </section>
      )}
    </div>
  )
}

/**
 * Bring in a video or a whole course.
 *
 * Pasting a link is the primary path and deliberately listed first: it needs no
 * API key and no quota, so it keeps working when search has hit its daily limit.
 * Search is the convenience on top, and says so when it runs out rather than
 * looking broken.
 */
function YouTubeDoor({ moduleId }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState('')
  const [instructor, setInstructor] = useState('')
  const [playlist, setPlaylist] = useState(true)

  const bring = useMutation({
    mutationFn: (body) => api.importYouTube(moduleId, body),
    onSuccess: (job) => {
      setUrl(''); setQuery(''); setInstructor('')
      queryClient.invalidateQueries({ queryKey: ['import-jobs', moduleId] })
      toast.success(
        job.kind === 'import_youtube'
          ? 'Fetching transcripts — you can leave this screen.'
          : 'Import started.',
      )
    },
    onError: (e) => toast.error(e?.message || 'Could not start that import.'),
  })

  return (
    <section className="card space-y-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-pri">
        <Video size={16} className="text-accent2" aria-hidden="true" />
        From YouTube
      </p>
      <p className="text-xs text-sec">
        We read the transcript, not the video — so you don&rsquo;t have to watch
        hours of it.
      </p>

      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a video or playlist link"
          className="input flex-1"
        />
        <button
          onClick={() => bring.mutate({ url })}
          disabled={!url.trim() || bring.isPending}
          className="btn-secondary px-4"
        >
          Add
        </button>
      </div>

      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <span className="text-[11px] uppercase tracking-wider text-sec">or search</span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Exam or course name"
        className="input w-full"
      />
      <div className="flex gap-2">
        <input
          value={instructor}
          onChange={(e) => setInstructor(e.target.value)}
          placeholder="Instructor (optional)"
          className="input flex-1"
        />
        <button
          onClick={() => setPlaylist((p) => !p)}
          aria-pressed={playlist}
          className={`min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium transition-colors ${
            playlist ? 'bg-accent text-white' : 'bg-surface2 text-sec'
          }`}
        >
          {playlist ? 'Playlist' : 'Single video'}
        </button>
      </div>
      <button
        onClick={() => bring.mutate({ query, instructor, playlist })}
        disabled={!query.trim() || bring.isPending}
        className="btn-secondary w-full"
      >
        {bring.isPending ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            Looking…
          </>
        ) : (
          'Search and import'
        )}
      </button>
    </section>
  )
}

/**
 * The parser's verdict, before anything is stored.
 *
 * Only shown where it contradicts the label — agreement needs no words.
 */
function Disagreement({ type, suggestion }) {
  const wantsQuestions = type === 'quiz' || type === 'practice_exam'
  const wouldBe = suggestion.would_be
  const mismatch =
    (wantsQuestions && wouldBe !== 'questions') ||
    (type === 'flashcards' && wouldBe !== 'flashcards')
  if (!mismatch) return null

  return (
    <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
      {suggestion.note ||
        `This looks more like ${OUTCOME[wouldBe] || 'study material'}.`}{' '}
      It&rsquo;ll still be imported as {OUTCOME[wouldBe] || 'study material'} —
      your label decides where it&rsquo;s filed, but options and answers
      can&rsquo;t be invented from material that doesn&rsquo;t have them.
    </p>
  )
}

function ImportRow({ job, onRetry }) {
  const done = job.completed_items || 0
  const failed = job.failed_items || 0
  const total = job.total_items || 0
  const running = job.status === 'queued' || job.status === 'running'

  return (
    <div className="card space-y-2">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
          {running ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : (
            <Upload size={16} aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-pri">
            {running ? 'Importing…' : 'Import finished'}
          </p>
          <p className="text-xs text-sec">
            {done} of {total} added{failed ? ` · ${failed} didn’t work` : ''}
          </p>
        </div>
        {failed > 0 && !running && (
          <button onClick={onRetry} className="btn-secondary shrink-0 px-3 py-1.5 text-xs">
            <RotateCcw size={13} aria-hidden="true" />
            Retry failed
          </button>
        )}
      </div>

      {job.items?.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2">
          {job.items.map((item) => (
            <div key={item.id} className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-sec">{item.title}</span>
              <span
                className={
                  item.status === 'succeeded'
                    ? 'shrink-0 text-success'
                    : item.status === 'failed'
                      ? 'shrink-0 text-warning'
                      : 'shrink-0 text-sec'
                }
              >
                {item.status === 'succeeded'
                  ? OUTCOME[item.result?.kind] || 'added'
                  : item.status === 'failed'
                    ? item.error || 'failed'
                    : item.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
