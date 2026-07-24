import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AudioLines, FileText, Globe, Loader2, Trash2, Video } from 'lucide-react'

import EmptyState from '../EmptyState'
import { useConfirm } from '../../hooks/useConfirm'
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

  if (!sources.length) {
    return (
      <EmptyState
        centered
        icon={FileText}
        title="No sources yet"
        message="Add a syllabus, lecture recording or notes with the button below — we’ll build your study plan from it."
      />
    )
  }

  return (
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
