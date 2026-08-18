/**
 * Interactive terms inside study text.
 *
 * Flashcards, quiz questions, exam questions and practice questions are all
 * generated with a short list of the terms a learner might not know. These
 * helpers turn that list plus a run of text into renderable segments: which
 * words are tappable, and where an acronym should carry its expansion inline.
 *
 * Deliberately pure — no React, no DOM — so the rules are testable and the
 * components stay about presentation.
 */

/** Escape a term for use inside a RegExp. */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Normalise and order a question's terms.
 *
 * Longest first, so "open source license" wins over "open source" and the
 * learner taps the phrase that was actually defined rather than a fragment of
 * it. Terms without the fields we need to show anything are dropped.
 */
export function usableTerms(terms) {
  if (!Array.isArray(terms)) return []
  return terms
    .filter((t) => t && typeof t.term === 'string' && t.term.trim() && t.definition)
    .map((t) => ({
      term: t.term.trim(),
      type: t.type === 'acronym' ? 'acronym' : 'vocabulary',
      expansion: (t.expansion || '').trim(),
      pronunciation: (t.pronunciation || '').trim(),
      definition: (t.definition || '').trim(),
      domain: (t.domain || '').trim(),
    }))
    .sort((a, b) => b.term.length - a.term.length)
}

/**
 * Which acronyms should show their expansion in each block of text.
 *
 * The expansion belongs on the *first* occurrence a learner reads, and a
 * question is several separate blocks (the question, then each option). Working
 * it out here — rather than letting each block decide for itself — keeps
 * rendering pure and stops "GNU (GNU's Not Unix)" repeating down the page.
 *
 * `blocks` is the text in reading order; returns one Set of terms per block.
 */
export function planExpansions(blocks, terms) {
  const list = usableTerms(terms).filter((t) => t.type === 'acronym' && t.expansion)
  const spent = new Set()
  return blocks.map((block) => {
    const here = new Set()
    if (!block) return here
    for (const t of list) {
      const key = t.term.toLowerCase()
      if (spent.has(key)) continue
      if (matcher(t.term).test(block)) {
        spent.add(key)
        here.add(key)
      }
    }
    return here
  })
}

/** A whole-word matcher that tolerates terms containing punctuation. */
function matcher(term) {
  const escaped = escapeRe(term)
  // \b doesn't behave around '+' or '/', so assert on non-word characters.
  return new RegExp(`(?<!\\w)${escaped}(?!\\w)`, 'i')
}

/**
 * Split `text` into renderable segments.
 *
 * Returns `[{ text }]` for plain runs and `{ text, term, expand }` for tappable
 * ones, where `expand` means this occurrence should render its acronym
 * expansion inline. Each term is marked once per block — the first time it
 * appears — because underlining every repeat turns the sentence into noise.
 */
export function segmentText(text, terms, expandSet) {
  const source = text || ''
  const list = usableTerms(terms)
  if (!source || !list.length) return [{ text: source }]

  const marked = []
  const taken = []
  for (const t of list) {
    const found = matcher(t.term).exec(source)
    if (!found) continue
    const start = found.index
    const end = start + found[0].length
    // Longest-first ordering means an earlier (longer) match wins any overlap.
    if (taken.some(([s, e]) => start < e && end > s)) continue
    taken.push([start, end])
    marked.push({
      start,
      end,
      matchedText: found[0],
      term: t,
      expand: !!(expandSet && expandSet.has(t.term.toLowerCase())),
    })
  }
  if (!marked.length) return [{ text: source }]

  marked.sort((a, b) => a.start - b.start)
  const segments = []
  let cursor = 0
  for (const m of marked) {
    if (m.start > cursor) segments.push({ text: source.slice(cursor, m.start) })
    segments.push({ text: m.matchedText, term: m.term, expand: m.expand })
    cursor = m.end
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor) })
  return segments
}

/** How a term is announced to a screen reader, and read aloud. */
export function spokenLabel(term) {
  if (!term) return ''
  return term.type === 'acronym' && term.expansion
    ? `${term.term}, ${term.expansion}`
    : term.term
}
