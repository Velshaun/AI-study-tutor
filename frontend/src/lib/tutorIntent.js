/**
 * Is this message worth asking the planner about?
 *
 * The planner is the thing that decides whether a message is an instruction, so
 * in principle every message should go through it. In practice that means a
 * second model call before every ordinary question, doubling the wait for the
 * overwhelmingly common case — someone asking about their subject.
 *
 * So this is a cheap local filter in front of it: cast wide, never decide
 * anything on its own. A false positive costs one small strict-schema call that
 * comes back `is_action: false` and falls through to the normal answer, which
 * the learner never sees. A false negative costs nothing worse than an answer
 * where an action was wanted, and rephrasing fixes it.
 *
 * Deliberately not clever. A regex that tried to *understand* the sentence
 * would be a second intent parser competing with the real one, and the two
 * would disagree.
 */

// Verbs that make something, remove something, or ask for a quantity of them.
const ACTION_WORDS = [
  'make', 'create', 'generate', 'build', 'give me', 'add',
  'delete', 'remove', 'clear', 'get rid of', 'wipe',
  'regenerate', 'redo', 'replace',
]

// Things the app can actually produce. An instruction almost always names one,
// and requiring a noun as well as a verb keeps "make sense of subnetting" out.
const OBJECT_WORDS = [
  'exam', 'exams', 'quiz', 'quizzes', 'flashcard', 'flashcards',
  'card', 'cards', 'paper', 'papers', 'test', 'tests', 'set', 'sets',
]

export function looksLikeInstruction(text) {
  const said = (text || '').toLowerCase()
  if (!said.trim()) return false

  const hasVerb = ACTION_WORDS.some((word) => said.includes(word))
  if (!hasVerb) return false

  // A question about how to do something is still a question: "how do I make a
  // practice exam?" wants an answer, not an exam.
  if (/^(how|why|what|when|where|who|can i|should i|is it|does)\b/.test(said.trim())) {
    return false
  }

  return OBJECT_WORDS.some((word) => said.includes(word))
}
