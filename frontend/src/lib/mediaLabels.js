import { formatClock } from './format'

/**
 * The one line under a generated item's name — whatever that type measures
 * itself in. A lecture is a running time, a quiz is questions and a last score,
 * a deck is cards.
 *
 * Here rather than beside the component because the repo keeps pure logic out
 * of React files, and because a file that exports both a component and a helper
 * breaks fast refresh.
 */
export function detailOf(kind, item) {
  if (kind === 'lecture') {
    return item.duration_secs ? formatClock(item.duration_secs) : 'Lecture'
  }
  if (kind === 'quiz') {
    return `${item.question_count || 0} questions${
      item.score != null ? ` · last ${Math.round(item.score)}%` : ''
    }`
  }
  // Practice reads like a quiz once it has been sat: the count, then the last
  // score. It showed the count alone however many times it had been taken,
  // which made a domain you had worked through look untouched.
  return `${item.count || 0} ${kind === 'flashcards' ? 'cards' : 'questions'}${
    kind === 'practice' && item.score != null
      ? ` · last ${Math.round(item.score)}%`
      : ''
  }`
}

/** How far into a lecture the learner actually got, for the listening view. */
export function listenedDetail(lecture) {
  const heard = lecture.last_position_secs || 0
  const whole = lecture.duration_secs || 0
  if (!heard) return 'not started'
  // Within ten seconds of the end reads as finished: nobody sits through a
  // closing sentence to make a number tidy.
  if (whole && heard >= whole - 10) return `finished · ${formatClock(whole)}`
  return `${formatClock(heard)} of ${formatClock(whole)}`
}

/**
 * What to call the module's cross-domain review material.
 *
 * The module's own name, plus two words saying what the section holds — it is
 * both missed questions and flagged ones, so neither word alone is honest.
 *
 * A trailing exam code goes: "LPI Linux Essentials (010-160) Review Set" is a
 * header nobody can skim, and the code is the one part of the title that says
 * nothing a learner looking at their own module needs told.
 */
export function reviewSetName(moduleTitle) {
  const trimmed = (moduleTitle || '').replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (!trimmed) return 'Review set'
  const short = trimmed.length > 28 ? `${trimmed.slice(0, 27).trimEnd()}…` : trimmed
  return `${short} Review Set`
}
