import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AudioLines,
  FileText,
  Globe,
  Link as LinkIcon,
  Loader2,
  Trash2,
  Upload,
  Video,
} from 'lucide-react'
import { useRef, useState } from 'react'

import { useConfirm } from '../../hooks/useConfirm'
import { api } from '../../lib/api'

/**
 * Sources card — spec Prompt 9 (audio uploads) + upload UI.
 *
 * Drag/drop or pick files (PDFs, audio, text), or paste a YouTube/web link.
 * Audio files are transcribed by Whisper server-side; each source row reflects
 * its pipeline state — an audio file shows a waveform icon and a "Transcribing
 * audio…" spinner while parsing, then a "Transcript ready" preview.
 */

const ACCEPT = '.pdf,.txt,.md,.mp3,.wav,.m4a,.mp4,.ogg,.webm,.flac,.mpga'
const AUDIO_EXT = /\.(mp3|wav|m4a|mp4|ogg|webm|flac|mpga|mpeg)$/i

function isAudio(name = '', type = '') {
  return AUDIO_EXT.test(name) || type.startsWith('audio/') || type.startsWith('video/')
}

export default function SourcesCard({ moduleId, sources, moduleStatus }) {
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const fileInput = useRef(null)
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
    mutationFn: () => api.processModule(moduleId),
    onSuccess: refresh,
    onError: (e) => setError(e?.message || 'Could not start processing.'),
  })

  function pick(files) {
    setError(null)
    const list = Array.from(files || [])
    if (list.length) upload.mutate(list)
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

      {/* Drop zone */}
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          pick(e.dataTransfer.files)
        }}
        className={[
          'flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8',
          'text-center transition-colors',
          dragging ? 'border-accent bg-surface2' : 'border-border hover:border-accent/50',
        ].join(' ')}
      >
        {upload.isPending ? (
          <Loader2 size={22} className="animate-spin text-accent" aria-hidden="true" />
        ) : (
          <Upload size={22} className="text-sec" aria-hidden="true" />
        )}
        <span className="text-sm text-pri">
          {upload.isPending ? 'Uploading…' : 'Drop files or tap to upload'}
        </span>
        <span className="text-xs text-sec">
          PDF, audio (MP3, WAV, M4A) or text
        </span>
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT}
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

      {error && <p className="text-sm text-warning">{error}</p>}

      {/* Source list */}
      {sources.length > 0 && (
        <ul className="space-y-2">
          {sources.map((s) => (
            <SourceRow key={s.id} source={s} onDelete={() => confirmRemove(s)} />
          ))}
        </ul>
      )}

      {/* Process */}
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
    </div>
  )
}

function SourceRow({ source, onDelete }) {
  const audio = isAudio(source.filename, '')
  const kind = source.source_type

  const Icon =
    kind === 'youtube'
      ? Video
      : kind === 'web'
        ? Globe
        : audio || kind === 'audio'
          ? AudioLines
          : FileText

  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface2/50 px-3 py-2.5">
      <Icon size={18} className="shrink-0 text-sec" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-pri">{source.filename}</p>
        <SourceStatus source={source} isAudio={audio || kind === 'audio'} />
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
