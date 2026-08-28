import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import { path } from '../../routes'

/**
 * Dashboard module card — a full-width list row.
 *
 * Left: the module name (in full, never truncated), its subject, an overall
 * progress bar and meta (sources · last updated). Right: a row of per-domain
 * tick marks. The most recently studied module is flagged with a green outline
 * and a "Continue" label so it stands out in a list of similar names.
 */
const PROCESSING = ['processing', 'parsing', 'analysing', 'queued']

function updatedLabel(iso) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export default function ModuleCard({ module, active = false }) {
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const domains = module.domains ?? []
  const total = domains.length
  const done = domains.filter((d) => d.status === 'completed').length
  const pct = total ? Math.round((done / total) * 100) : 0
  const processing = PROCESSING.includes(module.status)
  const failed = module.status === 'failed'
  const updated = updatedLabel(module.updated_at)
  const sourceN = module.source_count ?? 0

  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(module.title || '')

  const rename = useMutation({
    mutationFn: (title) => api.renameModule(module.id, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['modules'] }),
      onError: (e) => toast.error(e?.message || 'Could not rename that module.'),
  })

  function open() {
    if (!editing) {
      navigate(path(module.kind === 'workbook' ? 'workbook' : 'module',
                    { id: module.id }))
    }
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
      className={[
        'block w-full cursor-pointer rounded-2xl border bg-surface p-5 transition-colors',
        active
          // Dark keeps the green outline; light swaps to the accent purple with a
          // faint purple tint, since green sits badly on a white/purple palette.
          ? 'border-success/60 hover:border-success light:border-accent light:bg-[#f0eeff] light:hover:border-accent'
          : 'border-border hover:border-accent/40 hover:bg-surface2',
      ].join(' ')}
    >
      <div className="flex items-start gap-4">
        {/* Left: identity + progress */}
        <div className="min-w-0 flex-1 space-y-2">
          {active && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success light:text-accent">
              <span className="size-1.5 rounded-full bg-success light:bg-accent" aria-hidden="true" />
              Continue
            </span>
          )}

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
              className="group flex items-start gap-1.5 text-left"
            >
              {/* Full name — wraps, never truncates. */}
              <span className="wrap-anywhere text-base font-semibold leading-snug text-pri">
                {module.title || 'Processing…'}
              </span>
              <Pencil
                size={13}
                className="mt-1 shrink-0 text-sec opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              />
            </button>
          )}

          <p className="text-xs text-sec">
            {module.detected_subject ||
              (processing ? 'Detecting subject…' : 'Add a source to get started')}
          </p>

          {/* Overall progress */}
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
            <div className="space-y-1 pt-0.5">
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

          {/* Meta */}
          <p className="text-xs text-sec">
            {sourceN} source{sourceN === 1 ? '' : 's'}
            {updated && ` · Updated ${updated}`}
          </p>
        </div>

        {/* Right: per-domain tick marks */}
        {!processing && !failed && total > 0 && (
          <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
            <DomainTicks domains={domains} />
            <span className="text-[11px] tabular-nums text-sec">
              {done}/{total} done
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/** A row of small circles, one per domain (max 8, then "+N"). */
function DomainTicks({ domains }) {
  const MAX = 8
  const shown = domains.slice(0, MAX)
  const extra = domains.length - shown.length

  return (
    <div className="flex max-w-32 flex-wrap items-center justify-end gap-1">
      {shown.map((d) => (
        <Tick key={d.id} status={d.status} title={`${d.title}: ${d.status}`} />
      ))}
      {extra > 0 && (
        <span className="ml-0.5 text-[11px] font-medium text-sec tabular-nums">+{extra}</span>
      )}
    </div>
  )
}

function Tick({ status, title }) {
  let cls = 'border border-sec/40' // not started
  if (status === 'completed') cls = 'bg-accent border border-accent'
  else if (status === 'in_progress') cls = 'border-2 border-accent'
  return <span title={title} className={`size-2.5 shrink-0 rounded-full ${cls}`} aria-hidden="true" />
}
