import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown, FileText, ListVideo, Loader2, Trash2, Upload,
} from 'lucide-react'
import { useRef, useState } from 'react'

import EmptyState from '../EmptyState'
import { useConfirm } from '../../hooks/useConfirm'
import { useAddSourceToModule } from '../../hooks/useModuleUpload'
import { useToast } from '../../hooks/useToast'
import {
  UPLOAD_ACCEPT,
  isTranscribed,
  rejectionMessage,
  sortPicked,
} from '../../lib/uploads'
import SourceIcon from './SourceIcon'
import { api } from '../../lib/api'
import { groupSources, summariseSources } from '../../lib/imports'



/**
 * Sources tab — every uploaded source for the module, each with a type icon and
 * name. Adding sources happens through the fixed "Add a source" sheet (owned by
 * the module view); this list just shows and removes them.
 */
export default function SourcesTab({ moduleId, sources }) {
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const toast = useToast()

  // Both deletions land on the same invalidation, and both leave the server to
  // schedule the study-plan rebuild — it debounces by sixty seconds, so
  // clearing out four videos costs one rebuild rather than four.
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['sources', moduleId] })
    queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
  }

  const remove = useMutation({
    mutationFn: (id) => api.deleteSource(id),
    onSuccess: refresh,
    onError: (e) => toast.error(e?.message || 'Could not remove that source.'),
  })

  const removeGroup = useMutation({
    mutationFn: (key) => api.deleteSourceGroup(moduleId, key),
    onSuccess: refresh,
    onError: (e) => toast.error(e?.message || 'Could not remove that playlist.'),
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

  async function confirmRemoveGroup(group) {
    const count = group.sources.length
    const ok = await confirm({
      title: 'Remove this playlist?',
      // The count is the whole warning. "Remove playlist?" on something holding
      // ninety-seven transcripts reads like removing one thing.
      message:
        `All ${count} video${count === 1 ? '' : 's'} from "${group.title}" ` +
        'will be removed from this module. Your study plan will rebuild ' +
        'without them.',
      confirmLabel: `Remove ${count} video${count === 1 ? '' : 's'}`,
      danger: true,
    })
    if (ok) removeGroup.mutate(group.key)
  }

  const { rows } = groupSources(sources)

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
          {rows.map((row) =>
            row.kind === 'group' ? (
              <PlaylistRow
                key={row.key}
                group={row}
                onRemoveGroup={() => confirmRemoveGroup(row)}
                onRemoveVideo={confirmRemove}
              />
            ) : (
              <SourceRow
                key={row.source.id}
                source={row.source}
                onRemove={() => confirmRemove(row.source)}
              />
            ),
          )}
        </ul>
      )}
    </div>
  )
}

/** One source on its own — an upload, a paste, a single video. */
function SourceRow({ source, onRemove }) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface2 text-sec">
        <SourceIcon source={source} size={17} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-pri">{source.filename}</p>
        <SourceStatus source={source} />
      </div>
      <button
        onClick={onRemove}
        aria-label="Remove source"
        className="btn-ghost size-11 shrink-0 rounded-full p-0 hover:text-warning"
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </li>
  )
}

/**
 * A playlist: one row that opens.
 *
 * Importing one used to add a `user_files` row per video, so a 97-video course
 * pushed every PDF the learner had uploaded off the screen. It is one thing
 * they added, and it reads as one thing here — the same shape the import screen
 * already uses, so a playlist looks the same wherever it appears.
 *
 * Collapsed by default, which is the opposite of the import screen and right
 * for the opposite reason: there, the point is watching progress; here, the
 * point is everything *else* in the list.
 */
const VISIBLE_ROWS = 6
const ROW_HEIGHT_PX = 44

function PlaylistRow({ group, onRemoveGroup, onRemoveVideo }) {
  const [open, setOpen] = useState(false)

  return (
    <li className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-3 px-3 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
            <ListVideo size={17} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-pri">{group.title}</span>
            <span className="block text-xs text-sec">{summariseSources(group)}</span>
          </span>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`shrink-0 text-sec transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
        <button
          onClick={onRemoveGroup}
          aria-label={`Remove the playlist ${group.title}`}
          className="btn-ghost size-11 shrink-0 rounded-full p-0 hover:text-warning"
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>

      {open && (
        <ul
          className="overflow-y-auto border-t border-border"
          style={{ maxHeight: `${VISIBLE_ROWS * ROW_HEIGHT_PX}px` }}
        >
          {group.sources.map((video) => (
            <li
              key={video.id}
              className="flex items-center gap-2 px-3 py-2 pl-6 text-xs"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-pri">{video.filename}</p>
                <SourceStatus source={video} />
              </div>
              {/* Removing one video without losing the other ninety-six. */}
              <button
                onClick={() => onRemoveVideo(video)}
                aria-label={`Remove ${video.filename}`}
                className="btn-ghost size-9 shrink-0 rounded-full p-0 hover:text-warning"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
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
  const audio = isTranscribed(source)

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
