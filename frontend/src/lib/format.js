/**
 * Display formatting for dashboard values.
 *
 * Kept out of components so the rounding rules are testable — a KPI that says
 * "0h" for 50 minutes of study is worse than showing nothing.
 */

/** Study time: "3h 20m", "45m", "2m", "—" for nothing. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0))
  if (total === 0) return '—'
  if (total < 60) return '<1m'

  let hours = Math.floor(total / 3600)
  let minutes = Math.round((total % 3600) / 60)

  // Rounding can push the remainder to a full hour (3599s -> 60m, 7199s ->
  // 1h 60m). Carry it, so the value never reads as "60m" or "1h 60m".
  if (minutes === 60) {
    hours += 1
    minutes = 0
  }

  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

/** Playback position: "7:05". */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds || 0))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/** Percentage, or an em dash when there's genuinely no value. */
export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${Math.round(value)}%`
}

/** Progress pill colour for a domain state (§5.4). */
export function domainPillClass(status) {
  switch (status) {
    case 'completed':
      return 'bg-success'
    case 'in_progress':
    case 'unlocked':
      return 'bg-accent'
    default:
      return 'bg-border'
  }
}

export function domainPillLabel(status) {
  switch (status) {
    case 'completed':
      return 'complete'
    case 'in_progress':
      return 'in progress'
    default:
      // Everything else is simply open. There is no 'locked' any more, and a
      // default that says so would relabel every unrecognised status as a
      // gate that no longer exists.
      return 'available'
  }
}
