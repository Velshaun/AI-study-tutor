/**
 * Where to study next, ranked.
 *
 * Not "weakest first". A domain at 40% worth 4% of the paper is a worse use of
 * an evening than one at 60% worth 25% — the question is how many marks are
 * actually available, which is the gap multiplied by what the domain is worth.
 * Weakness alone would send someone to spend a night on 4% of the exam.
 *
 * On a module where the weights are close the two orderings agree, which is
 * most of the time; they diverge exactly when raw weakness would be wrong.
 *
 * Untouched domains rank on their own, deliberately. A domain nobody has
 * attempted has no readiness — treating that dash as 0% would park every
 * untouched domain above every measured weakness purely for being untouched,
 * which is the same mistake as `covered_pct` counting a bare mention. They sit
 * directly after the weakest measured domain instead: worth getting to, not
 * evidence of a gap.
 */

/** Marks still on the table in this domain, or null where nothing is known. */
export function pointsAtStake(entry) {
  if (!entry || entry.display == null || !entry.attempts) return null
  const weight = entry.weight_pct || 0
  return (weight * (100 - entry.display)) / 100
}

/**
 * Domains in the order they are worth studying.
 *
 * `domains` are the module's domains; `performance` is the `/stats/performance`
 * payload. Returns the same domain objects with `{ score, stake, measured }`
 * attached, so callers render one list and never re-derive the ranking.
 */
export function rankDomains(domains = [], performance = null) {
  const entryOf = Object.fromEntries(
    (performance?.domains || []).map((d) => [d.domain_id, d]),
  )

  const ranked = domains
    .filter((d) => !d.is_imported_deck)
    .map((domain) => {
      const entry = entryOf[domain.id] || null
      const stake = pointsAtStake(entry)
      return {
        ...domain,
        score: entry?.display ?? null,
        attempts: entry?.attempts ?? 0,
        weight_pct: entry?.weight_pct ?? domain.weight_pct ?? 0,
        stake,
        measured: stake != null,
      }
    })

  const measured = ranked.filter((d) => d.measured).sort((a, b) => b.stake - a.stake)
  // Blueprint order among the untouched: with nothing to tell them apart, the
  // vendor's own ordering is the only non-arbitrary tiebreak.
  const untouched = ranked
    .filter((d) => !d.measured)
    .sort((a, b) => (a.order_index || 0) - (b.order_index || 0))

  return [...measured, ...untouched]
}

/**
 * The one thing to do next.
 *
 * An unfinished lecture wins: it is already started, and finishing something is
 * cheaper than beginning something. Otherwise the domain with most marks on the
 * table. A module with no measurements at all points at the baseline, because
 * everything else here is guesswork until it has been taken.
 */
export function nextAction({ ranked = [], resume = null, hasBaseline = true }) {
  if (resume?.lecture_id) {
    return {
      kind: 'resume',
      title: resume.title || 'Carry on where you left off',
      reason: 'You stopped part-way through this one.',
      domainId: resume.domain_id || null,
      lectureId: resume.lecture_id,
    }
  }
  if (!hasBaseline) {
    return {
      kind: 'baseline',
      title: 'Take your baseline assessment',
      reason: 'It measures where you stand, so everything after it is aimed.',
    }
  }
  const target = ranked[0]
  if (!target) return null
  return {
    kind: target.measured ? 'weakest' : 'unstudied',
    title: target.title,
    reason: target.measured
      ? `${Math.round(target.weight_pct)}% of the paper, and you're at ${Math.round(target.score)}%.`
      : `${Math.round(target.weight_pct)}% of the paper, and you haven't been tested on it yet.`,
    domainId: target.id,
  }
}
