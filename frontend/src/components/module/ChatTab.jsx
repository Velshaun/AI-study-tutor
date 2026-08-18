import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  Check,
  FileText,
  Globe,
  Loader2,
  Plus,
  Search,
  ThumbsDown,
  Video,
} from 'lucide-react'
import { useRef, useState } from 'react'

import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'

/**
 * Chat tab — a module-scoped source-discovery tool (not a general chatbot).
 *
 * A query searches the web for free study material (videos, PDFs, docs, sites),
 * returned as cards you can add straight into the module's sources; a short
 * answer grounded in the module's own material follows. Everything is AI-
 * generated, hence the standing disclaimer under the input.
 */

const TYPE_ICON = {
  youtube: Video,
  pdf: FileText,
  docs: BookOpen,
  website: Globe,
}

export default function ChatTab({ moduleId }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const seq = useRef(0)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(() => new Set())
  const [reported, setReported] = useState(() => new Set())

  const add = useMutation({
    mutationFn: async (url) => {
      await api.addLink(moduleId, url)
      await api.processModule(moduleId)
    },
    onSuccess: (_data, url) => {
      setAdded((prev) => new Set(prev).add(url))
      queryClient.invalidateQueries({ queryKey: ['sources', moduleId] })
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      toast.success('Added to sources — reprocessing your module…')
    },
    onError: (e) => toast.error(e?.message || 'Could not add that source.'),
  })

  // The validator can prove a link is broken now; only the learner can say it
  // was useless. A reported link (and, after a few, its whole host) stops
  // coming back in this learner's searches.
  const report = useMutation({
    mutationFn: (url) => api.reportDeadLink(moduleId, url),
    onSuccess: (_data, url) => {
      setReported((prev) => new Set(prev).add(url))
      toast.success('Thanks — that one won’t come back')
    },
    onError: (e) => toast.error(e?.message || 'Could not report that link.'),
  })

  async function submit(e) {
    e.preventDefault()
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    seq.current += 1
    setMessages((m) => [...m, { id: seq.current, role: 'user', text: q }])
    setBusy(true)
    try {
      const res = await api.discover(moduleId, q)
      seq.current += 1
      setMessages((m) => [
        ...m,
        {
          id: seq.current,
          role: 'assistant',
          answer: res.answer,
          resources: res.resources,
          filtered: res.filtered_count || 0,
        },
      ])
    } catch (err) {
      seq.current += 1
      setMessages((m) => [
        ...m,
        { id: seq.current, role: 'assistant', error: err?.message || 'Search failed.' },
      ])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sec"
              aria-hidden="true"
            />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search for free study material..."
              className="input pl-9"
            />
          </div>
          <button type="submit" disabled={!input.trim() || busy} className="btn-primary px-4">
            {busy ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Search size={16} aria-hidden="true" />
            )}
          </button>
        </div>
        <p className="text-xs text-sec">Results are AI-generated. Always verify sources.</p>
      </form>

      {messages.length === 0 && !busy && (
        <div className="card flex flex-col items-center gap-3 py-10 text-center">
          <Search size={24} className="text-sec" aria-hidden="true" />
          <p className="mx-auto max-w-xs text-sm text-sec">
            Search for videos, free PDFs, docs and websites on any topic — add the
            good ones straight to this module’s sources.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div
              key={m.id}
              className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-surface2 px-4 py-2.5 text-sm text-pri"
            >
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="space-y-3">
              {m.error ? (
                <p className="rounded-2xl border border-warning/40 bg-surface px-4 py-3 text-sm text-warning">
                  {m.error}
                </p>
              ) : (
                <>
                  {m.resources?.some((r) => !reported.has(r.url)) && (
                    <div className="space-y-2">
                      {m.resources
                        .filter((r) => !reported.has(r.url))
                        .map((r, i) => (
                          <ResourceCard
                            key={`${m.id}-${i}`}
                            resource={r}
                            added={added.has(r.url)}
                            pending={add.isPending && add.variables === r.url}
                            reporting={report.isPending && report.variables === r.url}
                            onAdd={() => add.mutate(r.url)}
                            onReport={() => report.mutate(r.url)}
                          />
                        ))}
                    </div>
                  )}
                  {m.answer && (
                    <div className="rounded-2xl rounded-bl-sm border border-accent/25 bg-surface px-4 py-3">
                      <p className="text-sm leading-relaxed text-pri">{m.answer}</p>
                    </div>
                  )}
                  {/* Every suggestion is link-checked server-side, so say what
                      was thrown away rather than just showing a short list. */}
                  {m.filtered > 0 && (m.resources?.length > 0 || m.answer) && (
                    <p className="text-xs text-sec">
                      {m.filtered} broken, paywalled or off-topic{' '}
                      {m.filtered === 1 ? 'link' : 'links'} filtered out.
                    </p>
                  )}
                  {!m.answer && !m.resources?.length && (
                    <p className="text-sm text-sec">
                      {m.filtered > 0
                        ? `No freely accessible resources found — ${m.filtered} suggestion${
                            m.filtered === 1 ? ' was' : 's were'
                          } broken, paywalled or off-topic. Try rephrasing.`
                        : 'No free resources found — try rephrasing.'}
                    </p>
                  )}
                </>
              )}
            </div>
          ),
        )}

        {busy && (
          <div className="flex items-center gap-2.5 rounded-2xl bg-surface px-4 py-3">
            <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
            <p className="text-sm text-sec">Searching the web…</p>
          </div>
        )}
      </div>
    </div>
  )
}

function ResourceCard({ resource, added, pending, reporting, onAdd, onReport }) {
  const Icon = TYPE_ICON[resource.type] || Globe
  let host = resource.url
  try {
    host = new URL(resource.url).hostname.replace(/^www\./, '')
  } catch {
    /* keep the raw url */
  }

  return (
    <div className="card flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
        <Icon size={18} aria-hidden="true" />
      </span>
      <a
        href={resource.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1"
      >
        <p className="truncate text-sm font-medium text-pri">{resource.title}</p>
        <p className="truncate text-xs text-sec">{host}</p>
      </a>
      {added ? (
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-success">
          <Check size={14} aria-hidden="true" />
          Added
        </span>
      ) : (
        <button
          onClick={onAdd}
          disabled={pending}
          className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
        >
          {pending ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Plus size={13} aria-hidden="true" />
          )}
          Add to Sources
        </button>
      )}
      <button
        onClick={onReport}
        disabled={reporting}
        title="Broken or paywalled? Report it and it won't come back"
        aria-label={`Report ${resource.title} as broken`}
        className="shrink-0 rounded-lg p-2 text-sec transition-colors hover:bg-surface2 hover:text-warning"
      >
        {reporting ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <ThumbsDown size={14} aria-hidden="true" />
        )}
      </button>
    </div>
  )
}
