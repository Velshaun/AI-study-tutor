import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Pencil, Play } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { api } from '../../lib/api'
import { path } from '../../routes'

/**
 * Dashboard module card (§5.4, revised): name, cert/subject, an overall
 * progress bar, and a Resume button when a lecture in this module is in
 * progress. No KPI widgets — those live inside the module.
 *
 * The whole card opens the module; the title is tap-to-rename and the Resume
 * button jumps to the lecture, both stopping propagation so they don't navigate
 * into the module instead.
 */
const PROCESSING = ['processing', 'parsing', 'analysing', 'queued']

export default function ModuleCard({ module }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const domains = module.domains ?? []
  const total = domains.length
  const done = domains.filter((d) => d.status === 'completed').length
  const pct = total ? Math.round((done / total) * 100) : 0
  const processing = PROCESSING.includes(module.status)
  const failed = module.status === 'failed'

  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(module.title || '')

  const rename = useMutation({
    mutationFn: (title) => api.renameModule(module.id, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['modules'] }),
  })

  function open() {
    if (!editing) navigate(path('module', { id: module.id }))
  }
  function startEdit(e) {
    e.stopPropagation()
    setName(module.title || '')
    setEditing(true)
  }
  function commit() {
    const next = name.trim()
    setEditing(false)
    if (next && next !== module.title) rename.mutate(next)
  }
  function resume(e) {
    e.stopPropagation()
    navigate(path('lecture', { id: module.resume_lecture_id }))
  }

  return (
    <div
      onClick={open}
      onKeyDown={(e) => {
        if (!editing && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          open()
        }
      }}
      role="button"
      tabIndex={0}
      className="card-interactive flex h-full flex-col gap-3 cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={name}
              maxLength={200}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setName(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commit()
                } else if (e.key === 'Escape') {
                  setName(module.title || '')
                  setEditing(false)
                }
              }}
              className="w-full rounded-lg border border-accent bg-surface2 px-2 py-1
                         text-base font-semibold text-pri focus:outline-none"
              aria-label="Module name"
            />
          ) : (
            <button
              type="button"
              onClick={startEdit}
              title="Rename module"
              className="group flex max-w-full items-center gap-1.5 text-left"
            >
              <span className="truncate text-base font-semibold text-pri">
                {module.title || 'Processing…'}
              </span>
              <Pencil
                size={13}
                className="shrink-0 text-sec opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              />
            </button>
          )}
          <p className="mt-0.5 truncate text-xs text-sec">
            {module.detected_subject ||
              (processing ? 'Detecting subject…' : 'Add a source to get started')}
          </p>
        </div>
        <ChevronRight size={18} className="mt-0.5 shrink-0 text-sec" aria-hidden="true" />
      </div>

      {/* Progress / state */}
      <div className="mt-auto">
        {failed ? (
          <p className="text-xs text-warning">
            {module.error_message || 'Processing failed.'}
          </p>
        ) : processing ? (
          <div className="flex items-center gap-2 text-xs text-sec">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            {module.status_detail || 'Processing'}…
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-sec">
              <span>{total > 0 ? `${done}/${total} domains` : 'Ready'}</span>
              {total > 0 && <span className="tabular-nums">{pct}%</span>}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface2">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${
                  pct >= 100 ? 'bg-success' : 'bg-accent'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Resume, when a lecture is part-way through */}
      {module.resume_lecture_id && (
        <button
          onClick={resume}
          className="btn inline-flex items-center justify-center gap-1.5 bg-accent/15 py-2
                     text-sm font-medium text-accent2 hover:bg-accent/20"
        >
          <Play size={14} aria-hidden="true" />
          Resume lecture
        </button>
      )}
    </div>
  )
}
