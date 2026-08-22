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
  return `${item.count || 0} ${kind === 'flashcards' ? 'cards' : 'questions'}`
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
