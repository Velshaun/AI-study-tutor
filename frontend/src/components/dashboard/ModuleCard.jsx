import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, FileText, Pencil } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { api } from '../../lib/api'
import { domainPillClass } from '../../lib/format'
import { path } from '../../routes'

/**
 * Module card with domain progress pills (§5.4).
 *
 * The AI names the module during processing; the learner can rename it here by
 * tapping the title (inline edit, no separate screen). The card itself is a
 * click/keyboard target that opens the module — the title's own click is stopped
 * so tapping the name edits rather than navigates.
 */
export default function ModuleCard({ module }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const domains = module.domains ?? []
  const processing = module.status !== 'ready' && module.status !== 'failed'

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
      className="card-interactive block cursor-pointer"
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
            {module.detected_subject || `${module.source_count ?? 0} source(s)`}
            {module.domain_count > 0 && ` · ${module.domain_count} domains`}
          </p>
        </div>
        <ChevronRight size={18} className="mt-0.5 shrink-0 text-sec" aria-hidden="true" />
      </div>

      {module.source_summary && (
        <p className="mt-3 line-clamp-2 text-sm text-sec">
          {module.source_summary}
        </p>
      )}

      {module.status === 'failed' ? (
        <p className="mt-3 text-xs text-warning">
          {module.error_message || 'Processing failed.'}
        </p>
      ) : processing ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-sec">
          <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
          {module.status_detail || 'Processing'}…
        </div>
      ) : domains.length > 0 ? (
        <div className="mt-4 flex gap-1" aria-label="Domain progress">
          {domains.map((d) => (
            <span
              key={d.id}
              title={`${d.title}: ${d.status}`}
              className={`h-1.5 flex-1 rounded-full ${domainPillClass(d.status)}`}
            />
          ))}
        </div>
      ) : (
        module.domain_count > 0 && (
          <div className="mt-4 flex items-center gap-2 text-xs text-sec">
            <FileText size={13} aria-hidden="true" />
            {module.domain_count} domains
          </div>
        )
      )}
    </div>
  )
}
