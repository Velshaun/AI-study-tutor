import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown, Flag, GraduationCap, HelpCircle, Sparkles, Target, Trash2,
} from 'lucide-react'
import { useState } from 'react'

import { useConfirm } from '../../hooks/useConfirm'
import { useToast } from '../../hooks/useToast'
import { api } from '../../lib/api'
import GenerateFromPool from '../study/GenerateFromPool'

/**
 * One of the two containers, as a Classroom section.
 *
 * They live here rather than in a tab of their own because they are scoped to a
 * module, and the Classroom is already the module-scoped view — organised by
 * domain, with the things that span the whole blueprint sitting outside the
 * domain list. A container spans the blueprint in exactly that way.
 *
 * The two behave identically. The only difference is what they can be turned
 * into: Q&A can't produce a lecture, because it came from one — a rule the
 * server enforces and this only reflects.
 */

const SHAPE = {
  missed: {
    title: 'Missed questions',
    Icon: Target,
    blurb: 'Questions you got wrong or flagged, from anywhere in this module.',
    empty:
      'Nothing here yet. At the end of a quiz, exam or deck you’ll be asked '
      + 'whether to add what you missed.',
  },
  qa: {
    title: 'Lecture Q&A',
    Icon: HelpCircle,
    blurb: 'What you asked the tutor while listening, and what it answered.',
    empty: 'Nothing here yet. Ask a question during a lecture and it lands here.',
  },
}

export default function ContainerSection({ moduleId, container }) {
  const shape = SHAPE[container] || SHAPE.missed
  const { Icon } = shape
  const [open, setOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const confirm = useConfirm()
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data, isPending } = useQuery({
    queryKey: ['container', moduleId, container],
    queryFn: ({ signal }) => api.container(moduleId, container, signal),
    enabled: Boolean(moduleId),
  })
  const entries = Array.isArray(data) ? data : []

  const remove = useMutation({
    mutationFn: (id) => api.deleteContainerEntry(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['container', moduleId, container] }),
    onError: (e) => toast.error(e?.message || 'Could not remove that one.'),
  })

  const generate = useMutation({
    mutationFn: (body) => api.generateFromContainer(moduleId, container, body),
    onSuccess: (res) => {
      setGenerating(false)
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] })
      toast.success(
        `Made ${res.media.replace('_', ' ')} from ${res.used} question`
        + `${res.used === 1 ? '' : 's'}.${res.note ? ` ${res.note}` : ''}`,
      )
    },
    onError: (e) => toast.error(e?.message || 'Could not generate that.'),
  })

  async function confirmRemove(entry) {
    const ok = await confirm({
      title: 'Remove this question?',
      message:
        'It leaves this container. Anything already generated from it stays.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) remove.mutate(entry.id)
  }

  return (
    <section className="card space-y-3">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent2">
          <Icon size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-pri">{shape.title}</h3>
          <p className="text-xs text-sec">
            {isPending
              ? 'Loading…'
              : entries.length
                ? `${entries.length} question${entries.length === 1 ? '' : 's'}`
                : shape.blurb}
          </p>
        </div>
        {entries.length > 0 && (
          <button
            onClick={() => setGenerating(true)}
            className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
          >
            <Sparkles size={13} aria-hidden="true" />
            Generate
          </button>
        )}
      </div>

      {entries.length === 0 && !isPending && (
        <p className="text-xs leading-relaxed text-sec">{shape.empty}</p>
      )}

      {entries.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex min-h-9 w-full items-center justify-between text-xs text-accent2"
          >
            <span>{open ? 'Hide' : 'Show'} questions</span>
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={`transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>

          {open && (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto border-t border-border pt-2">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2 text-xs">
                  <span className="mt-1 flex shrink-0 gap-1">
                    {entry.missed && (
                      <span className="text-warning" title="You got this wrong">
                        <Target size={11} aria-hidden="true" />
                      </span>
                    )}
                    {entry.flagged && (
                      <span className="text-warning" title="You flagged this">
                        <Flag size={11} fill="currentColor" aria-hidden="true" />
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-pri">
                      {entry.snapshot?.prompt
                        || entry.snapshot?.question
                        || 'Saved question'}
                    </span>
                    {entry.correct_streak > 0 && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-success">
                        <GraduationCap size={10} aria-hidden="true" />
                        {entry.correct_streak} right in a row — one more retires it
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => confirmRemove(entry)}
                    aria-label="Remove this question"
                    className="btn-ghost size-9 shrink-0 rounded-full p-0 hover:text-warning"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <GenerateFromPool
        open={generating}
        onClose={() => setGenerating(false)}
        busy={generate.isPending}
        available={entries.length}
        title={`Generate from ${shape.title.toLowerCase()}`}
        onGenerate={(body) => generate.mutate(body)}
      />
    </section>
  )
}
