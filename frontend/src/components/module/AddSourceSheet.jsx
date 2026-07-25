import { Loader2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'

import Modal from '../Modal'
import { UPLOAD_ACCEPT, useAddSourceToModule } from '../../hooks/useModuleUpload'

/**
 * The "Add a source" bottom sheet for an existing module. Drops or picks files,
 * attaches them to *this* module and re-runs the pipeline — so a new source
 * augments the module rather than creating a duplicate.
 */
export default function AddSourceSheet({ open, moduleId, onClose }) {
  const input = useRef(null)
  const depth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const upload = useAddSourceToModule(moduleId)

  function pick(files) {
    const list = Array.from(files || [])
    if (list.length) upload.mutate(list, { onSuccess: onClose })
  }

  return (
    <Modal open={open} title="Add a source" onClose={onClose}>
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
          'flex w-full flex-col items-center gap-2 rounded-xl border-2 px-4 py-8 text-center transition-colors',
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
          <span className="text-xs text-sec">PDF, audio (MP3, WAV, M4A) or text</span>
        )}
      </button>
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
