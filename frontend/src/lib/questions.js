/**
 * The four question kinds, and one opinion about grading them.
 *
 * Mirrors `backend/app/services/grading.py` — same kinds, same normalisation,
 * same all-or-nothing rule for multi-select. The server's grade is always the
 * one recorded; this exists so a quiz that ships its key can mark itself
 * without a round trip, and a runner can style options without guessing.
 *
 * The shared shape, wherever questions travel:
 *   kind             'mcq' | 'multi' | 'short' | 'blank'   (absent = mcq)
 *   correct_index    number            — mcq
 *   correct_indices  number[]          — multi
 *   accepted         string[]          — short and blank
 *
 * An answer is whatever the kind calls one: an index, an index array, or the
 * typed text.
 */

export const TEXT_KINDS = ['short', 'blank']

export function kindOf(question) {
  const kind = (question?.kind || 'mcq').toLowerCase()
  return ['mcq', 'multi', 'short', 'blank'].includes(kind) ? kind : 'mcq'
}

export function isTextKind(question) {
  return TEXT_KINDS.includes(kindOf(question))
}

export function isAnswered(answer) {
  if (answer == null) return false
  if (Array.isArray(answer)) return answer.length > 0
  if (typeof answer === 'string') return answer.trim().length > 0
  return true
}

/** Case, surrounding punctuation and internal whitespace are presentation. */
export function normaliseAnswer(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,:;!?'"`]+|[\s.,:;!?'"`]+$/g, '')
}

export function correctIndicesOf(question) {
  const many = question?.correct_indices
  if (Array.isArray(many) && many.length) return [...many].map(Number).sort((a, b) => a - b)
  return question?.correct_index != null ? [Number(question.correct_index)] : []
}

export function acceptedOf(question) {
  return (question?.accepted || []).map(String).filter((a) => a.trim())
}

export function isCorrect(question, answer) {
  if (!isAnswered(answer)) return false
  const kind = kindOf(question)

  if (kind === 'multi') {
    if (!Array.isArray(answer)) return false
    const chosen = [...answer].map(Number).sort((a, b) => a - b)
    const wanted = correctIndicesOf(question)
    // The whole set, exactly — partial credit turns "select all that apply"
    // into a different question.
    return wanted.length > 0
      && chosen.length === wanted.length
      && chosen.every((v, i) => v === wanted[i])
  }

  if (TEXT_KINDS.includes(kind)) {
    if (typeof answer !== 'string') return false
    const given = normaliseAnswer(answer)
    return Boolean(given) && acceptedOf(question).some((a) => normaliseAnswer(a) === given)
  }

  return question?.correct_index != null && Number(answer) === Number(question.correct_index)
}

/** What a recorded answer looks like in prose, for results and history. */
export function answerLabel(question, answer) {
  if (!isAnswered(answer)) return '—'
  const options = question?.options || []
  if (Array.isArray(answer)) {
    return answer.map((i) => options[i] ?? String.fromCharCode(65 + i)).join(', ')
  }
  if (typeof answer === 'string') return answer
  return options[answer] ?? String.fromCharCode(65 + Number(answer))
}
