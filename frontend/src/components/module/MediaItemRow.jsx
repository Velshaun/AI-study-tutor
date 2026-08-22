import { BookOpen, Play, Trash2 } from 'lucide-react'

import * as lectures from '../../lib/lectures'
import { detailOf } from '../../lib/mediaLabels'

/**
 * One generated thing, as a row: what it is called, what it measures itself in,
 * and a way in.
 *
 * Extracted from the Classroom's media rows so the KPI views can show the same
 * pill rather than a lookalike. That is the whole reason it is a component: a
 * second implementation of "a lecture, listed" would drift the first time
 * either side gained a state — a lecture still generating, a deck with a count
 * — and the two lists would quietly disagree about the same row.
 */
export default function MediaItemRow({ kind, item, onOpen, onRemove, detail }) {
  const pending = kind === 'lecture' && !lectures.isReady(item.status)

  return (
    <li className="flex items-center gap-2 py-2 pe-2 ps-3 text-xs">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-pri">{item.title}</span>
        <span className="block truncate text-[11px] text-sec">
          {pending ? lectures.generatingLabel(item.status) : detail ?? detailOf(kind, item)}
        </span>
      </span>
      <button
        type="button"
        onClick={() => !pending && onOpen?.(item)}
        disabled={pending}
        aria-label={`Open ${item.title}`}
        className="flex size-9 shrink-0 items-center justify-center rounded-lg
                   text-accent2 transition-colors hover:bg-accent/10
                   disabled:opacity-40"
      >
        {kind === 'lecture'
          ? <Play size={14} aria-hidden="true" />
          : <BookOpen size={14} aria-hidden="true" />}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(item)}
          aria-label={`Remove ${item.title}`}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg
                     text-sec transition-colors hover:bg-danger/10
                     hover:text-danger disabled:opacity-40"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

