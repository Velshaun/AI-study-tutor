import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardList,
  FileText,
  Layers,
  ListVideo,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

import PageTitle from '../components/PageTitle'
import { useGoBack } from '../hooks/useGoBack'
import { useJobs } from '../hooks/useJobs'
import { useToast } from '../hooks/useToast'
import { api } from '../lib/api'
import {
  estimateRemaining, formatRemaining, groupItems, isFinished, summarise,
} from '../lib/imports'
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
  // Pops rather than pushes the module route: pushing it made the
  // browser's own back button return here, and this button push it again.
  const goBack = useGoBack(path('module', { id: moduleId }))
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

  // Stopping an import that's already running. Whatever landed stays — the
  // queue keeps succeeded items and only drops what hadn't started, so
  // cancelling a 97-video playlist forty videos in leaves forty transcripts
  // rather than nothing.
  const stop = useMutation({
    mutationFn: (id) => api.cancelImport(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-jobs', moduleId] })
      toast.success('Import stopped. Anything already read has been kept.')
    },
    onError: (e) => toast.error(e?.message || 'Could not stop that import.'),
  })

  return (
    <div className="space-y-6">
      <PageTitle
        onBack={goBack}
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
            <ImportRow
              key={job.id}
              job={job}
              onRetry={() => retry.mutate(job.id)}
              onCancel={() => stop.mutate(job.id)}
            />
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
/**
 * What the link turned out to be, and where it's about to go.
 *
 * The point of the step is that nothing has happened yet. A playlist of ninety
 * -seven videos reads as a sentence before it reads as an import, the domain is
 * a choice rather than a consequence, and Cancel costs nothing because there is
 * nothing to undo.
 */
function Confirmation({ preview, domainId, onDomain, busy, onCancel, onConfirm }) {
  const many = preview.kind === 'playlist'

  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent2">
          {many ? <ListVideo size={14} aria-hidden="true" />
                : <Video size={14} aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-pri">{preview.title}</p>
          <p className="text-xs text-sec">
            {many ? `Playlist · ${preview.video_count} videos` : 'Single video'}
          </p>
        </div>
      </div>

      <label className="block space-y-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-sec">
          File under
        </span>
        <select
          value={domainId}
          onChange={(e) => onDomain(e.target.value)}
          className="input w-full"
        >
          {/* Deliberately first and selectable: when nothing in the title
              matched, saying so beats pre-selecting whichever domain happened
              to sort first and hoping nobody looks. */}
          <option value="">Let the app decide per video</option>
          {(preview.domains || []).map((d) => (
            <option key={d.id} value={d.id}>{d.title}</option>
          ))}
        </select>
      </label>

      {preview.note && <p className="text-xs text-sec">{preview.note}</p>}

      <div className="flex gap-2">
        <button onClick={onCancel} disabled={busy}
                className="btn-secondary flex-1 py-2 text-xs">
          Cancel
        </button>
        <button onClick={onConfirm} disabled={busy}
                className="btn-primary flex-1 py-2 text-xs">
          {busy ? 'Starting…' : many ? `Import ${preview.video_count} videos` : 'Import'}
        </button>
      </div>
    </div>
  )
}


function YouTubeDoor({ moduleId }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState('')
  const [instructor, setInstructor] = useState('')
  const [playlist, setPlaylist] = useState(true)
  // What the link turned out to be, waiting to be confirmed. Nothing is queued
  // while this is set — it is the whole point of the step.
  const [preview, setPreview] = useState(null)
  const [domainId, setDomainId] = useState('')

  // Identify first. A pasted link used to start importing on the spot, so the
  // first time anyone found out they had the wrong playlist was after it had
  // been read — and a transcript is far cheaper to fetch than to unpick from a
  // module afterwards.
  const look = useMutation({
    mutationFn: (link) => api.previewYouTube(moduleId, link),
    onSuccess: (found) => {
      setPreview(found)
      setDomainId(found.domain_id || '')
    },
    onError: (e) => toast.error(e?.message || 'Could not read that link.'),
  })

  const bring = useMutation({
    mutationFn: (body) => api.importYouTube(moduleId, body),
    onSuccess: (job) => {
      setUrl(''); setQuery(''); setInstructor(''); setPreview(null); setDomainId('')
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
          onChange={(e) => {
            setUrl(e.target.value)
            // Editing the link invalidates whatever was confirmed about the
            // old one.
            if (preview) setPreview(null)
          }}
          placeholder="Paste a video or playlist link"
          className="input min-w-0 flex-1"
        />
        <button
          onClick={() => look.mutate(url)}
          disabled={!url.trim() || look.isPending || bring.isPending}
          className="btn-secondary shrink-0 px-4"
        >
          {look.isPending ? 'Checking…' : 'Check'}
        </button>
      </div>

      {preview && (
        <Confirmation
          preview={preview}
          domainId={domainId}
          onDomain={setDomainId}
          busy={bring.isPending}
          onCancel={() => setPreview(null)}
          onConfirm={() =>
            bring.mutate({ url, domain_id: domainId || null })
          }
        />
      )}

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

/**
 * How many video rows the scroll area shows before it scrolls.
 *
 * Five or six is the point where the group still reads as a list you can take
 * in, and the import as a whole still fits on a phone screen alongside whatever
 * else is importing. A twenty-two-row playlist rendered in full pushed every
 * other job, and the Import All button, off the bottom.
 */
const VISIBLE_ROWS = 6
const ROW_HEIGHT_PX = 34

function ImportRow({ job, onRetry, onCancel }) {
  const done = job.completed_items || 0
  const failed = job.failed_items || 0
  const total = job.total_items || 0
  const running = job.status === 'queued' || job.status === 'running'
  const { groups, loose } = groupItems(job.items || [])

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
            {running ? 'Importing\u2026' : 'Import finished'}
          </p>
          <p className="text-xs text-sec">
            {done} of {total} added{failed ? ` \u00b7 ${failed} didn\u2019t work` : ''}
          </p>
        </div>
        {running && (
          <button
            onClick={onCancel}
            className="btn-secondary shrink-0 px-3 py-1.5 text-xs hover:text-warning"
          >
            <X size={13} aria-hidden="true" />
            Stop
          </button>
        )}
        {failed > 0 && !running && (
          <button onClick={onRetry} className="btn-secondary shrink-0 px-3 py-1.5 text-xs">
            <RotateCcw size={13} aria-hidden="true" />
            Retry failed
          </button>
        )}
      </div>

      {(groups.length > 0 || loose.length > 0) && (
        <div className="space-y-2 border-t border-border pt-2">
          {groups.map((group) => (
            <Playlist key={group.id} group={group} job={job} running={running} />
          ))}
          {loose.map((item) => (
            <ItemLine key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A playlist, drawn as the one thing the learner actually asked for.
 *
 * Expanded from the start, because the reason to watch a playlist import is to
 * see which video it has got to \u2014 collapsed by default would hide the only
 * moving part behind a tap. Collapsing stays available for when it has finished
 * and you want the screen back.
 */
function Playlist({ group, job, running }) {
  const [open, setOpen] = useState(true)
  const finished = group.done + group.failed
  const remaining = useRemaining({
    claimedAt: job.claimed_at,
    finished,
    total: group.total,
    live: running,
  })

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent2">
          <ListVideo size={14} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-pri">
            {group.title}
          </span>
          <span className="block text-[11px] text-sec">
            {summarise(group)}
            {remaining ? ` \u00b7 ${remaining}` : ''}
          </span>
        </span>
        <ChevronDown
          size={15}
          aria-hidden="true"
          className={`shrink-0 text-sec transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && group.total > 0 && (
        <VideoList videos={group.videos} activeIndex={group.activeIndex} />
      )}
    </div>
  )
}

/**
 * The scrolling list of videos, kept on whichever one is being read.
 *
 * `scrollIntoView` rather than a computed offset: row heights are the browser's
 * to decide once a title wraps, and arithmetic over an assumed height drifts
 * further with every wrapped title until it is centring the wrong row.
 * `block: 'nearest'` leaves the scroll alone when the active row is already
 * visible, so reading the list isn't fought by the next tick.
 */
function VideoList({ videos, activeIndex }) {
  const activeRef = useRef(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div
      className="overflow-y-auto border-t border-border"
      style={{ maxHeight: `${VISIBLE_ROWS * ROW_HEIGHT_PX}px` }}
    >
      {videos.map((video, index) => (
        <ItemLine
          key={video.id}
          item={video}
          rowRef={index === activeIndex ? activeRef : null}
          index={index}
        />
      ))}
    </div>
  )
}

const STATE_STYLE = {
  succeeded: 'text-success',
  failed: 'text-warning',
  running: 'text-accent2',
}

/** One source, whatever it came from \u2014 a video, or a pasted blob. */
function ItemLine({ item, rowRef, index }) {
  const state = item.status
  const tone = STATE_STYLE[state] || 'text-sec'

  return (
    <div
      ref={rowRef}
      className="flex min-h-[34px] items-center gap-2 px-3 py-1.5 text-xs"
    >
      <span className={`flex w-4 shrink-0 justify-center ${tone}`}>
        {state === 'succeeded' ? (
          <Check size={12} aria-hidden="true" />
        ) : state === 'failed' ? (
          <AlertTriangle size={12} aria-hidden="true" />
        ) : state === 'running' ? (
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        ) : (
          <span className="text-[10px] tabular-nums text-sec">
            {index == null ? '\u00b7' : index + 1}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sec">{item.title}</span>
      <span className={`shrink-0 ${tone}`}>{itemLabel(item)}</span>
    </div>
  )
}

/**
 * A failed item says why in one short phrase.
 *
 * The queue stores the library's full explanation \u2014 several paragraphs
 * about proxies, in the case that actually happened \u2014 and putting that in a
 * row makes the list unreadable. The distinction worth a learner's attention is
 * whether it is worth trying again, which is the distinction the queue already
 * records to decide what Retry Failed touches.
 */
function itemLabel(item) {
  if (item.status === 'succeeded') return OUTCOME[item.result?.kind] || 'added'
  if (item.status === 'failed') {
    return item.failure_kind === 'transient'
      ? 'couldn\u2019t reach it'
      : 'no captions'
  }
  if (item.status === 'running') return 'reading\u2026'
  if (isFinished(item)) return item.status
  return 'waiting'
}

/**
 * The remaining-time phrase, recomputed on a timer while the job runs.
 *
 * It ticks rather than being derived once because the estimate's whole value is
 * that it falls: a figure frozen at "about 4 minutes" for four minutes is worse
 * than no figure. The interval is cleared the moment the job stops running, so
 * a finished import isn't holding a timer open on a screen nobody is watching.
 */
function useRemaining({ claimedAt, finished, total, live }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!live) return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  if (!live) return ''
  return formatRemaining(estimateRemaining({ claimedAt, finished, total, now }))
}
