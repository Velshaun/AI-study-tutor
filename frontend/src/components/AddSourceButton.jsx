import { Loader2, Plus } from 'lucide-react'
import { useRef } from 'react'

import { UPLOAD_ACCEPT, useModuleUpload } from '../hooks/useModuleUpload'

/**
 * A persistent "Add source" control. Opens the file picker and runs the shared
 * upload — always available (e.g. in the sidebar) so a learner is never trapped
 * after their first upload.
 */
export default function AddSourceButton({ className = '' }) {
  const input = useRef(null)
  const upload = useModuleUpload()

  return (
    <>
      <button
        onClick={() => input.current?.click()}
        disabled={upload.isPending}
        className={
          className ||
          'flex w-full items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-sm font-medium text-sec transition-colors hover:border-accent/50 hover:text-pri'
        }
      >
        {upload.isPending ? (
          <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
        ) : (
          <Plus size={16} aria-hidden="true" />
        )}
        {upload.isPending ? 'Uploading…' : 'Add source'}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = e.target.files
          e.target.value = ''
          if (files?.length) upload.mutate(files)
        }}
      />
    </>
  )
}
