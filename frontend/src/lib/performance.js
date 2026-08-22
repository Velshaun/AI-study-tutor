/**
 * How domain strength is shown.
 *
 * The backend decides what a domain's status is; this decides what that looks
 * like, in one place, so a colour never means two different things on two
 * screens. The rules it enforces are the ones that matter to someone revising:
 *
 * - Red is reserved. It needs a low score *and* a pattern of them, which is why
 *   status comes from the server rather than being derived here from a
 *   percentage. Turning a screen red after one bad evening teaches people to
 *   stop taking practice exams, which is the opposite of the point.
 * - The big number is the rolling one. Today's result is shown next to it,
 *   smaller, so a bad session is visible without being the headline.
 */

export const STATUS = {
  strong: {
    label: 'Strong',
    text: 'text-success',
    bar: 'bg-success',
    chip: 'bg-success/15 text-success',
  },
  developing: {
    label: 'Developing',
    text: 'text-warning',
    bar: 'bg-warning',
    chip: 'bg-warning/15 text-warning',
  },
  weak: {
    label: 'Needs work',
    text: 'text-danger',
    bar: 'bg-danger',
    chip: 'bg-danger/15 text-danger',
  },
  untouched: {
    label: 'Not started',
    text: 'text-sec',
    bar: 'bg-surface2',
    chip: 'bg-surface2 text-sec',
  },
}

export function statusOf(entry) {
  return STATUS[entry?.status] || STATUS.untouched
}

/** The rolling score as text — a dash where nothing has been attempted. */
export function displayScore(entry) {
  return entry?.display == null ? '—' : `${Math.round(entry.display)}%`
}

/**
 * How today compares with the rolling score, in words.
 *
 * The server writes the sentence; this is only the short label beside the
 * number. Both avoid arithmetic like "down 28 points", which is true and
 * useless — the learner cannot act on a subtraction.
 */
export function sessionLabel(entry) {
  if (entry?.session == null || entry?.attempts < 1) return ''
  if (entry.attempts === 1) return 'first attempt'
  const gap = entry.session - entry.display
  if (gap >= 5) return 'best yet'
  if (gap >= -5) return 'about usual'
  return 'a dip'
}

/** Progress through a domain's study material, for the collapsed row. */
export function mediaSummary({ lecture, flashcards, quizzes, practice }) {
  const parts = []
  // A number, not a flag: a domain holds as many lectures as were asked for,
  // and "Lecture" beside three of them undersells what is there.
  if (lecture) parts.push(`${lecture} lecture${lecture === 1 ? '' : 's'}`)
  if (flashcards) parts.push(`${flashcards} card${flashcards === 1 ? '' : 's'}`)
  if (quizzes) parts.push(`${quizzes} quiz${quizzes === 1 ? '' : 'zes'}`)
  if (practice) parts.push(`${practice} practice`)
  return parts.length ? parts.join(' · ') : 'Nothing generated yet'
}

/**
 * A domain's study state, from what exists and what has been graded.
 *
 * Deliberately three states and no more: a learner glancing down a list wants
 * to know where to go next, and a five-point scale makes that a decision rather
 * than a glance.
 */
export function domainProgress(entry, media) {
  const hasMedia = Boolean(
    media?.lecture || media?.flashcards || media?.quizzes || media?.practice,
  )
  if (entry?.status === 'strong' && entry?.attempts) return 'complete'
  if (entry?.attempts || hasMedia) return 'in_progress'
  return 'not_started'
}

export const PROGRESS_COPY = {
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'Looking solid',
}
