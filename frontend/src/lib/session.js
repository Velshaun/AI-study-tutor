/**
 * What happened in one sitting, in a shape every runner can produce.
 *
 * Four runners disagree about almost everything — a quiz carries its answer key
 * and reveals on selection, an exam withholds it until submission, practice mode
 * posts each answer as it is given, flashcards have no options at all. What they
 * agree on is the only thing the results screen and the containers need: for
 * each item, what it was, what was chosen, whether that was right, and whether
 * it was flagged.
 *
 * So each runner maps its own state into `Result` once, at the end, and
 * everything downstream — the tiles, the confirmation prompt, the session
 * record, generating from a past sitting — reads that one shape.
 */

/** Tile states. Green for right, red for wrong; the flag is separate. */
import { isAnswered, isCorrect } from './questions'

export const CORRECT = 'correct'
export const WRONG = 'wrong'
export const UNANSWERED = 'unanswered'

export function stateOf(result) {
  if (result?.chosen_index == null && !result?.answered) return UNANSWERED
  return result?.correct ? CORRECT : WRONG
}

/**
 * Normalise one runner's arrays into results.
 *
 * `correctIndexOf` is a function rather than a field because the runners keep
 * the key in different places — a quiz has it on the question, an exam only
 * learns it from the server's response. Passing a getter means neither has to
 * reshape its own state to call this.
 */
export function toResults({
  questions = [], answers = [], flags = new Set(),
  correctIndexOf = (q) => q?.correct_index,
  promptOf = (q) => q?.question ?? q?.prompt ?? '',
  optionsOf = (q) => q?.options ?? [],
} = {}) {
  return questions.map((question, index) => {
    const chosen = answers[index]
    const correctIndex = correctIndexOf(question, index)
    const answered = isAnswered(chosen)
    return {
      index,
      prompt: promptOf(question),
      options: optionsOf(question),
      // The kind, and everything grading it needs — a banked snapshot has to
      // stand alone once the quiz it came from is deleted, and a multi-select
      // snapshot without its correct set is a question nobody can re-serve.
      kind: question?.kind || 'mcq',
      correct_indices: question?.correct_indices || [],
      accepted: question?.accepted || [],
      correct_index: correctIndex ?? null,
      chosen_index: answered && typeof chosen === 'number' ? chosen : null,
      chosen: answered ? chosen : null,
      // Graded by the kind's own rule, the same one the server applies.
      correct: isCorrect(
        { ...question, correct_index: correctIndex ?? question?.correct_index },
        chosen,
      ),
      answered,
      flagged: flags.has(index),
      explanation: question?.explanation ?? '',
      source_kind: question?.source_kind ?? 'practice_question',
      source_id: question?.id ?? null,
      domain_id: question?.domain_id ?? null,
      // Only set when this question came from a container, and the whole of
      // how auto-graduation gets told what happened.
      bank_entry_id: question?.bank_entry_id ?? null,
    }
  })
}

/** Headline numbers for the results screen. */
export function summarise(results = []) {
  const total = results.length
  const correct = results.filter((r) => r.correct).length
  const missed = results.filter((r) => stateOf(r) !== CORRECT).length
  const flagged = results.filter((r) => r.flagged).length
  return {
    total,
    correct,
    missed,
    flagged,
    // Both, counted without double-counting: a question can be wrong *and*
    // flagged, and offering to bank "12 questions" when there are 9 is the
    // kind of small lie that makes people stop reading prompts.
    bankable: results.filter((r) => stateOf(r) !== CORRECT || r.flagged).length,
    pct: total ? Math.round((correct / total) * 100) : 0,
  }
}

/**
 * Which results are eligible for a container, and why each one is.
 *
 * `source` selects what the learner asked for on the generate dialog:
 * 'missed', 'flagged', or 'both'. The confirmation prompt at the end of a
 * session always offers 'both', because that is the moment the information
 * exists and asking twice would be worse.
 */
export function bankable(results = [], source = 'both') {
  return results
    .filter((r) => {
      const wrong = stateOf(r) !== CORRECT
      if (source === 'missed') return wrong
      if (source === 'flagged') return r.flagged
      return wrong || r.flagged
    })
    .map((r) => ({
      source_kind: r.source_kind,
      source_id: r.source_id,
      // A re-served container question names its own entry — the strongest
      // "this already exists" signal the pool's dedupe has.
      bank_entry_id: r.bank_entry_id ?? null,
      domain_id: r.domain_id,
      missed: stateOf(r) !== CORRECT,
      flagged: Boolean(r.flagged),
      // The snapshot is the entry: it has to stand alone once the exam it came
      // from is deleted.
      snapshot: {
        prompt: r.prompt,
        kind: r.kind || 'mcq',
        options: r.options,
        correct_index: r.correct_index,
        correct_indices: r.correct_indices || [],
        accepted: r.accepted || [],
        explanation: r.explanation,
      },
    }))
}

/** "9 questions — 7 you missed, 4 you flagged" for the confirmation prompt. */
export function bankPrompt(results = []) {
  const { missed, flagged, bankable: count } = summarise(results)
  if (!count) return ''
  const parts = []
  if (missed) parts.push(`${missed} you missed`)
  if (flagged) parts.push(`${flagged} you flagged`)
  return (
    `Add ${count} question${count === 1 ? '' : 's'} to this module's missed ` +
    `questions? That's ${parts.join(' and ')}.`
  )
}
