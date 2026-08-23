import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Link as LinkIcon,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react'
import { useRef, useState } from 'react'

import { useConfirm } from '../../hooks/useConfirm'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import {
  UPLOAD_ACCEPT,
  isTranscribed,
  rejectionMessage,
  sortPicked,
} from '../../lib/uploads'
import SourceIcon from './SourceIcon'
import ErrorBanner from '../ErrorBanner'

/**
 * Sources card — spec Prompt 9 (audio uploads) + upload UI.
 *
 * Drag/drop or pick files (PDFs, audio, text), or paste a YouTube/web link.
 * Audio files are transcribed by Whisper server-side; each source row reflects
 * its pipeline state — an audio file shows a waveform icon and a "Transcribing
 * audio…" spinner while parsing, then a "Transcript ready" preview.
 */



export default function SourcesCard({ moduleId, sources, moduleStatus }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const fileInput = useRef(null)
  // Depth counter for drag enter/leave: dragging over the zone's own children
  // (icon, labels) fires leave/enter, so a plain boolean flickers. Counting
  // keeps the highlight steady until the cursor truly leaves the zone.
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [error, setError] = useState(null)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['sources', moduleId] })
    queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
  }

  const upload = useMutation({
    mutationFn: (files) => api.uploadSources(moduleId, files),
    onSuccess: refresh,
    onError: (e) => setError(e?.message || 'Upload failed.'),
  })
  const addLink = useMutation({
    mutationFn: (url) => api.addLink(moduleId, url),
    onSuccess: () => {
      setLinkUrl('')
      refresh()
    },
    onError: (e) => setError(e?.message || 'Could not add that link.'),
  })
  const remove = useMutation({
    mutationFn: (id) => api.deleteSource(id),
    onSuccess: refresh,
      onError: (e) => toast.error(e?.message || 'Could not remove that source.'),
  })

  async function confirmRemove(source) {
    const ok = await confirm({
      title: 'Remove source?',
      message: `"${source.filename}" will be removed from this module.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) remove.mutate(source.id)
  }
  const process = useMutation({
    mutationFn: ({ force = false } = {}) => api.processModule(moduleId, { force }),
    onSuccess: refresh,
    onError: (e) => setError(e?.message || 'Could not start processing.'),
  })

  // Re-processing keeps any domain the learner has already studied, so the
  // normal path needs no warning. A full rebuild is the only way to lose that
  // work, so it asks first — and says exactly what would go.
  async function rebuild() {
    setError(null)
    let atRisk
    try {
      const impact = await api.reprocessImpact(moduleId)
      atRisk = impact?.at_risk_domains || []
    } catch (e) {
      setError(e?.message || 'Could not check what a rebuild would affect.')
      return
    }

    const total = atRisk.reduce(
      (n, d) => n + Object.values(d.counts || {}).reduce((a, b) => a + b, 0), 0,
    )
    const ok = await confirm({
      title: total ? 'Rebuild and delete your study content?' : 'Rebuild study plan?',
      message: total
        ? `This rebuilds the domain list from your sources and permanently deletes ` +
          `${total} generated item${total === 1 ? '' : 's'} across ` +
          `${atRisk.length} domain${atRisk.length === 1 ? '' : 's'}: ` +
          `${atRisk.map((d) => d.title).join(', ')}. ` +
          `Re-processing normally keeps all of it — only rebuild if the plan itself is wrong.`
        : 'This rebuilds the domain list from your sources. Nothing has been generated yet, so nothing will be lost.',
      confirmLabel: total ? 'Delete and rebuild' : 'Rebuild',
      danger: !!total,
    })
    if (ok) process.mutate({ force: true })
  }

  function pick(files) {
    setError(null)
    const { accepted, csv, rejected } = sortPicked(files)
    if (rejected.length) setError(rejectionMessage(rejected))
    if (csv.length) {
      setError(
        'CSV files are imported as flashcard decks, not summarised as sources — ' +
          'use the CSV import in "Add a source".',
      )
    }
    if (accepted.length) upload.mutate(accepted)
  }

  // --- Drag & drop (desktop). Dropped files go through the same `pick` handler
  // as the file picker — one code path, one set of validation/processing. Drag
  // events never fire from a touch tap, so mobile keeps its tap-to-upload flow
  // untouched.
  function onDragEnter(e) {
    e.preventDefault()
    // Ignore drags that aren't files (selected text, page elements, …).
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }
  function onDragOver(e) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  function onDrop(e) {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    pick(e.dataTransfer.files)
  }

  const processing = ['processing', 'parsing', 'analysing', 'queued'].includes(
    moduleStatus,
  )
  const canProcess = sources.length > 0 && !processing && !upload.isPending

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-pri">Sources</h2>
        <span className="text-xs text-sec">
          {sources.length} source{sources.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Drop zone — three states: default (dashed), drag-over (solid purple +
          tint), uploading (spinner). */}
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={[
          'flex w-full flex-col items-center gap-2 rounded-xl border-2 px-4 py-8',
          'text-center transition-colors',
          dragging
            ? 'border-solid border-accent bg-accent/10'
            : 'border-dashed border-border hover:border-accent/50',
        ].join(' ')}
      >
        {upload.isPending ? (
          <Loader2 size={22} className="animate-spin text-accent" aria-hidden="true" />
        ) : (
          <Upload
            size={22}
            className={dragging ? 'text-accent2' : 'text-sec'}
            aria-hidden="true"
          />
        )}
        <span className={`text-sm ${dragging ? 'font-medium text-accent2' : 'text-pri'}`}>
          {upload.isPending
            ? 'Uploading…'
            : dragging
              ? 'Drop to upload'
              : 'Drag & drop or click to upload'}
        </span>
        {!dragging && (
          <span className="text-xs text-sec">PDF, audio (MP3, WAV, M4A) or text</span>
        )}
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        onChange={(e) => pick(e.target.files)}
        className="hidden"
      />

      {/* Paste a link */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (linkUrl.trim()) addLink.mutate(linkUrl.trim())
        }}
        className="flex gap-2"
      >
        <div className="relative flex-1">
          <LinkIcon
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sec"
            aria-hidden="true"
          />
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="YouTube or web link"
            className="input pl-9"
          />
        </div>
        <button
          type="submit"
          disabled={!linkUrl.trim() || addLink.isPending}
          className="btn-secondary"
        >
          Add
        </button>
      </form>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      {/* Source list */}
      {sources.length > 0 && (
        <ul className="space-y-2">
          {sources.map((s) => (
            <SourceRow key={s.id} source={s} onDelete={() => confirmRemove(s)} />
          ))}
        </ul>
      )}

      {/* Process */}
      <div className="space-y-2">
        <button
          onClick={() => process.mutate()}
          disabled={!canProcess}
          className="btn-primary w-full"
        >
          {processing ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              Building your study plan…
            </>
          ) : (
            'Generate study plan'
          )}
        </button>
        {/* Escape hatch for a plan that came out wrong. Hidden until there is
            something to rebuild, so it never competes with the main action. */}
        {sources.length > 0 && (
          <button
            onClick={rebuild}
            disabled={!canProcess}
            className="w-full text-xs text-sec underline-offset-2 hover:text-pri hover:underline"
          >
            Rebuild the plan from scratch
          </button>
        )}
      </div>
    </div>
  )
}

function SourceRow({ source, onDelete }) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface2/50 px-3 py-2.5">
      <SourceIcon source={source} size={18} className="shrink-0 text-sec" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-pri">{source.filename}</p>
        <SourceStatus source={source} isAudio={isTranscribed(source)} />
      </div>
      <button
        onClick={onDelete}
        aria-label="Remove source"
        className="btn-ghost size-11 shrink-0 rounded-full p-0 hover:text-warning"
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </li>
  )
}

function SourceStatus({ source, isAudio: audio }) {
  const status = source.status

  if (status === 'parsing' || status === 'pending') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-accent2">
        <Loader2 size={11} className="animate-spin" aria-hidden="true" />
        {audio ? 'Transcribing audio…' : 'Reading…'}
      </span>
    )
  }
  if (status === 'parsed') {
    const preview = (source.preview || '').slice(0, 100)
    return (
      <span className="text-xs text-sec">
        {audio ? 'Transcript ready' : 'Ready'}
        {preview && <span className="text-sec"> · {preview}…</span>}
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="text-xs text-warning">
        {source.error_message || 'Failed to process'}
      </span>
    )
  }
  return <span className="text-xs text-sec">Queued</span>
}
