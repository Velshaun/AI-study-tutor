import {
  Camera,
  ChevronRight,
  ClipboardPaste,
  FileSpreadsheet,
  FolderOpen,
  Images,
  Loader2,
  MonitorPlay,
  Upload,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import Modal from '../Modal'
import { api } from '../../lib/api'
import { useAddSourceToModule, useModuleUpload } from '../../hooks/useModuleUpload'
import { path } from '../../routes'
import {
  DOCUMENT_ACCEPT,
  IMAGE_ACCEPT,
  LIBRARY_ACCEPT,
  SUPPORTED_SUMMARY,
  UPLOAD_ACCEPT,
  VIDEO_ACCEPT,
  rejectionMessage,
  sortPicked,
} from '../../lib/uploads'

/**
 * The "Add a source" bottom sheet for an existing module. Picks or drops files,
 * attaches them to *this* module and re-runs the pipeline — so a new source
 * augments the module rather than creating a duplicate.
 *
 * A phone's file picker is driven entirely by the `accept` list, and one
 * combined list makes it guess: it opens whichever app it thinks fits, which is
 * why photos of notes were unreachable behind a video-only picker. So the
 * routes are explicit — library, files, camera, screen recording — each with
 * the accept (and `capture`) that opens the right thing. Desktop keeps the
 * drag-and-drop zone, which takes everything.
 *
 * CSVs never run the ingestion pipeline: picked anywhere here, they are handed
 * to the flashcard importer instead.
 */
/**
 * `moduleId` is optional. Without one the same sheet serves the dashboard,
 * where every route creates the module as its first act — which is what the
 * dashboard's file picker already did, so nothing new is being committed to.
 *
 * Sharing the component rather than reimplementing four of the seven routes is
 * the point: the dashboard offered files and camera while the module offered
 * seven ways in, so the fastest way to import a playlist was to create a module
 * from something else first.
 */
export default function AddSourceSheet({ open, moduleId, onClose, onImportCsv }) {
  const navigate = useNavigate()
  // One input, retargeted per route. The `accept` list (and `capture`) is what
  // decides which app a phone opens, and setting it at click time keeps that
  // decision in the handler rather than spraying inputs across the markup.
  const input = useRef(null)
  const depth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(null)
  // Two hooks, one of which is inert: hooks cannot be called conditionally, and
  // the unused one costs nothing until its mutate is called.
  const addToModule = useAddSourceToModule(moduleId)
  const createModule = useModuleUpload()
  const upload = moduleId ? addToModule : createModule

  function pick(files) {
    setError(null)
    const { accepted, csv, rejected } = sortPicked(files)

    if (rejected.length) setError(rejectionMessage(rejected))

    // A CSV is a flashcard deck, not study material to summarise, so it goes
    // to the importer rather than the pipeline. The importer asks for the file
    // itself — it has to show the column mapping before anything is written.
    if (csv.length && !accepted.length) {
      onImportCsv?.()
      return
    }
    if (csv.length) {
      setError(
        'CSV files are imported as flashcard decks — add them on their own, ' +
          'using "CSV (Flashcards)".',
      )
    }
    if (accepted.length) upload.mutate(accepted, { onSuccess: onClose })
  }

  function openPicker({ accept, capture }) {
    const el = input.current
    if (!el) return
    el.accept = accept
    // A camera capture is one shot; everything else can be a multi-select.
    el.multiple = !capture
    if (capture) el.setAttribute('capture', capture)
    else el.removeAttribute('capture')
    el.value = ''
    el.click()
  }

  const routes = [
    {
      accept: LIBRARY_ACCEPT,
      Icon: Images,
      title: 'Choose from library',
      hint: 'Photos and videos on this device',
    },
    {
      accept: DOCUMENT_ACCEPT,
      Icon: FolderOpen,
      title: 'Browse files',
      hint: 'PDFs, documents, audio and CSVs',
    },
    {
      accept: IMAGE_ACCEPT,
      capture: 'environment',
      Icon: Camera,
      title: 'Take photo',
      hint: 'Snap notes, a page or a whiteboard',
    },
    {
      accept: VIDEO_ACCEPT,
      Icon: MonitorPlay,
      title: 'Add a screen recording',
      hint: 'We read the text off each screen',
    },
  ]

  return (
    <Modal open={open} title="Add a source" onClose={onClose}>
      <div className="space-y-3">
        {/* Desktop dropzone. On a phone this is just another way in. */}
        <button
          type="button"
          onClick={() => openPicker({ accept: UPLOAD_ACCEPT })}
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
            'flex w-full flex-col items-center gap-2 rounded-xl border-2 px-4 py-6 text-center transition-colors',
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
                ? 'Drop to add'
                : 'Drag & drop or click to add'}
          </span>
          {!dragging && !upload.isPending && (
            <span className="text-xs text-sec">{SUPPORTED_SUMMARY}</span>
          )}
        </button>

        {routes.map(({ accept, capture, Icon, title, hint }) => (
          <SourceRoute
            key={title}
            Icon={Icon}
            title={title}
            hint={hint}
            disabled={upload.isPending}
            onClick={() => openPicker({ accept, capture })}
          />
        ))}

        {/* CSV flashcard import — bypasses the ingestion pipeline. */}
        <SourceRoute
          Icon={FileSpreadsheet}
          title="CSV (Flashcards)"
          hint="Import a Quizlet or two-column CSV as a deck"
          onClick={async () => {
            if (moduleId) {
              onImportCsv?.()
              return
            }
            onClose?.()
            try {
              const created = await api.createModule()
              // ?csv=1 opens the importer on arrival, so the dashboard route
              // ends in the same place the in-module one starts.
              navigate(`${path('module', { id: created.id })}?csv=1`)
            } catch {
              // As above.
            }
          }}
        />

        {/* Pasting needs room to stage several sources and correct their
            labels, so it leaves the sheet for a screen of its own rather than
            becoming a fourth cramped option here.

            Named for the doors it opens rather than for the gesture: "Paste
            material" read as somewhere to put text, so the YouTube half went
            unnoticed — and a pasted *playlist* is the single highest-value
            thing this screen does. */}
        <SourceRoute
          Icon={ClipboardPaste}
          title="Paste URL or YouTube"
          hint="A video or playlist link, flashcards, captions or a past paper"
          onClick={async () => {
            onClose?.()
            if (moduleId) {
              navigate(path('importSources', { id: moduleId }))
              return
            }
            // From the dashboard there is nowhere to paste into yet. Creating
            // the module here is the same commitment the file routes make, and
            // the pipeline names it from whatever lands.
            try {
              const created = await api.createModule()
              navigate(path('importSources', { id: created.id }))
            } catch {
              // The screen it would have opened is the only thing lost; the
              // sheet has already closed, so a toast would be shouting into an
              // empty room. The learner can try again.
            }
          }}
        />

        {error && (
          <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            {error}
          </p>
        )}
      </div>

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
    </Modal>
  )
}

function SourceRoute({ Icon, title, hint, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded-xl border border-border
                 bg-surface px-4 py-3 text-left transition-colors
                 hover:border-accent/50 disabled:opacity-60"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
        <Icon size={18} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-pri">{title}</span>
        <span className="block text-xs text-sec">{hint}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-sec" aria-hidden="true" />
    </button>
  )
}
