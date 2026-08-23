import { AlertTriangle } from 'lucide-react'

/**
 * Progress is not reaching the server, said for as long as it is true.
 *
 * Deliberately not a block: a flaky connection must not wall someone mid-exam,
 * and every answer is still held in the tab. Equally deliberately not a toast —
 * four seconds against a forty-minute sitting is a warning aimed at nobody.
 * A learner who knows can finish in one go rather than closing the tab and
 * discovering afterwards what that cost.
 */
export default function ProgressWarning({ failing }) {
  if (!failing) return null
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-xl border border-warning/40
                 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        Your progress isn&rsquo;t saving — check your connection. Your answers
        are safe here, but don&rsquo;t close this tab until it clears.
      </span>
    </p>
  )
}
