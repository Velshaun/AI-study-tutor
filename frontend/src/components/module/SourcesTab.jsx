import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AudioLines, FileText, Globe, Loader2, Trash2, Upload, Video } from 'lucide-react'
import { useRef, useState } from 'react'

import EmptyState from '../EmptyState'
import { useConfirm } from '../../hooks/useConfirm'
import { useAddSourceToModule } from '../../hooks/useModuleUpload'
import { useToast } from '../../hooks/useToast'
import { UPLOAD_ACCEPT, rejectionMessage, sortPicked } from '../../lib/uploads'
import { api } from '../../lib/api'

const AUDIO_EXT = /\.(mp3|wav|m4a|mp4|ogg|webm|flac|mpga|mpeg)$/i

function iconFor(source) {
  const kind = source.source_type
  const audio = AUDIO_EXT.test(source.filename || '') || kind === 'audio'
  if (kind === 'youtube') return Video
  if (kind === 'web') return Globe
  if (audio) return AudioLines
  return FileText
}

/**
 * Sources tab — every uploaded source for the module, each with a type icon and
 * name. Adding sources happens through the fixed "Add a source" sheet (owned by
 * the module view); this list just shows and removes them.
 */
export default function SourcesTab({ moduleId, sources }) {
  const queryClient = useQueryClient()
  const confirm = useConfirm()

  const remove = useMutation({
    mutationFn: (id) => api.deleteSource(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
    },
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

  return (
    <div className="space-y-4">
      {/* Desktop-only drag & drop zone (mobile uses the Add-a-source button) */}
      <DesktopDropzone moduleId={moduleId} />

      {sources.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No sources yet"
          message="Add a syllabus, lecture recording or notes with the button below — we’ll build your study plan from it."
        />
      ) : (
        <ul className="space-y-2">
          {sources.map((s) => {
            const Icon = iconFor(s)
            return (
              <li
                key={s.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-3"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface2 text-sec">
                  <Icon size={17} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-pri">{s.filename}</p>
                  <SourceStatus source={s} />
                </div>
                <button
                  onClick={() => confirmRemove(s)}
                  aria-label="Remove source"
                  className="btn-ghost size-11 shrink-0 rounded-full p-0 hover:text-warning"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Visible drop target, desktop only. Same pipeline as "Add a source". */
function DesktopDropzone({ moduleId }) {
  const input = useRef(null)
  const depth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const upload = useAddSourceToModule(moduleId)
  const toast = useToast()

  function pick(files) {
    const { accepted, rejected } = sortPicked(files)
    // CSVs land in `accepted` here on purpose: this dropzone belongs to the
    // sources list, and a CSV of notes is perfectly good study text. The
    // flashcard importer is a separate, explicit choice.
    if (rejected.length) toast.error(rejectionMessage(rejected))
    if (accepted.length) upload.mutate(accepted)
  }

  return (
    <button
      type="button"
      onClick={() => input.current?.click()}
      onDragEnter={(e) => {
        e.preventDefault()
        if (![...(e.dataTransfer?.types || [])].includes('Files')) return
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        depth.current = 0
        setDragging(false)
        pick(e.dataTransfer.files)
      }}
      disabled={upload.isPending}
      className={[
        'hidden w-full flex-col items-center gap-2 rounded-2xl border-2 px-4 py-7',
        'text-center transition-colors md:flex',
        dragging
          ? 'border-solid border-accent bg-accent/10'
          : 'border-dashed border-border hover:border-accent/50',
      ].join(' ')}
    >
      {upload.isPending ? (
        <Loader2 size={22} className="animate-spin text-accent" aria-hidden="true" />
      ) : (
        <Upload size={22} className={dragging ? 'text-accent2' : 'text-sec'} aria-hidden="true" />
      )}
      <span className={`text-sm ${dragging ? 'font-medium text-accent2' : 'text-pri'}`}>
        {upload.isPending
          ? 'Uploading…'
          : dragging
            ? 'Drop to add source'
            : 'Drag & drop a file to add a source'}
      </span>
      {!dragging && !upload.isPending && (
        <span className="text-xs text-sec">PDF, audio (MP3, WAV, M4A) or text</span>
      )}
      <input
        ref={input}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => {
          pick(e.target.files)
          e.target.value = ''
        }}
      />
    </button>
  )
}

function SourceStatus({ source }) {
  const status = source.status
  const audio = AUDIO_EXT.test(source.filename || '') || source.source_type === 'audio'

  if (status === 'parsing' || status === 'pending') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-accent2">
        <Loader2 size={11} className="animate-spin" aria-hidden="true" />
        {audio ? 'Transcribing audio…' : 'Reading…'}
      </span>
    )
  }
  if (status === 'parsed') {
    return (
      <span className="text-xs text-sec">{audio ? 'Transcript ready' : 'Ready'}</span>
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
