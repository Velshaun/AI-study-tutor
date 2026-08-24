import { ChevronDown } from 'lucide-react'

/**
 * The tail of a list that would otherwise grow forever.
 *
 * History accumulates by design — every sitting is kept — so any list drawn
 * from it gets longer every week, and fifteen rows of retrospective push the
 * material below them off the screen. The newest few are the ones anyone
 * returns for; the rest stay one tap away rather than gone.
 *
 * Same affordance the classroom's accordions use — chevron, rotate,
 * `aria-expanded` — so expanding history feels like expanding anything else
 * here. Shared between the two history lists rather than written twice,
 * because two copies of a control drift the first time one is touched.
 */
export default function ShowAllToggle({ total, shown, expanded, onToggle, noun = 'items' }) {
  if (total <= shown) return null
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex min-h-9 w-full items-center justify-center gap-1.5
                 text-xs font-medium text-accent2"
    >
      {expanded ? 'Show fewer' : `Show all ${total} ${noun}`}
      <ChevronDown
        size={14}
        aria-hidden="true"
        className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
      />
    </button>
  )
}
