import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, FileText, Loader2, Type, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { api } from '../../lib/api'

/**
 * Course Context card — spec Prompt 9.3.
 *
 * The learner's syllabus / exam objectives, stored in modules.course_context
 * and fed to domain extraction as a reference layer. Two input modes — paste
 * text or upload a file (PDF/text) — matching the backend's PUT endpoint, which
 * accepts either.
 */
export default function CourseContextCard({ moduleId }) {
  const queryClient = useQueryClient()
  const fileInput = useRef(null)
  const [mode, setMode] = useState('paste') // 'paste' | 'upload'
  const [text, setText] = useState('')
  const [error, setError] = useState(null)

  const { data } = useQuery({
    queryKey: ['course-context', moduleId],
    queryFn: ({ signal }) => api.courseContext(moduleId, signal),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['course-context', moduleId] })

  const saveText = useMutation({
    mutationFn: (value) => api.setCourseContextText(moduleId, value),
    onSuccess: () => {
      setText('')
      setError(null)
      invalidate()
    },
    onError: (e) => setError(e?.message || 'Could not save.'),
  })
  const saveFile = useMutation({
    mutationFn: (file) => api.setCourseContextFile(moduleId, file),
    onSuccess: () => {
      setError(null)
      invalidate()
    },
    onError: (e) => setError(e?.message || 'Could not read that file.'),
  })
  const clear = useMutation({
    mutationFn: () => api.clearCourseContext(moduleId),
    onSuccess: invalidate,
  })

  const existing = data?.course_context
  const saving = saveText.isPending || saveFile.isPending

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-base font-semibold text-pri">Course Context</h2>
        <p className="mt-0.5 text-sm text-sec">
          Add your syllabus, exam objectives, or any requirements that guide your
          study plan.
        </p>
      </div>

      {existing ? (
        <div className="space-y-3">
          <div className="rounded-xl bg-surface2 px-3 py-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-accent2">
              <Check size={13} aria-hidden="true" />
              {data.course_context_filename
                ? data.course_context_filename
                : 'Context added'}
              <span className="text-sec">· {data.char_count} chars</span>
            </div>
            <p className="line-clamp-3 text-sm text-sec">{existing}</p>
          </div>
          <button
            onClick={() => clear.mutate()}
            className="btn-ghost text-xs text-warning"
          >
            <X size={13} aria-hidden="true" />
            Remove context
          </button>
        </div>
      ) : (
        <>
          {/* Mode toggle */}
          <div className="inline-flex rounded-xl border border-border p-0.5 text-sm">
            <button
              onClick={() => setMode('paste')}
              className={[
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5',
                mode === 'paste' ? 'bg-surface2 text-pri' : 'text-sec',
              ].join(' ')}
            >
              <Type size={14} aria-hidden="true" />
              Paste text
            </button>
            <button
              onClick={() => setMode('upload')}
              className={[
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5',
                mode === 'upload' ? 'bg-surface2 text-pri' : 'text-sec',
              ].join(' ')}
            >
              <Upload size={14} aria-hidden="true" />
              Upload file
            </button>
          </div>

          {mode === 'paste' ? (
            <div className="space-y-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste your syllabus or exam objectives…"
                rows={5}
                className="input resize-y"
              />
              <button
                onClick={() => text.trim().length >= 20 && saveText.mutate(text.trim())}
                disabled={text.trim().length < 20 || saving}
                className="btn-primary w-full"
              >
                {saving ? (
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                ) : (
                  'Save context'
                )}
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => fileInput.current?.click()}
                className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed
                           border-border px-4 py-6 text-center transition-colors hover:border-accent/50"
              >
                {saving ? (
                  <Loader2 size={20} className="animate-spin text-accent" aria-hidden="true" />
                ) : (
                  <FileText size={20} className="text-sec" aria-hidden="true" />
                )}
                <span className="text-sm text-pri">Upload a syllabus (PDF or text)</span>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.txt,.md"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) saveFile.mutate(f)
                }}
                className="hidden"
              />
            </>
          )}

          {error && <p className="text-sm text-warning">{error}</p>}
        </>
      )}
    </div>
  )
}
