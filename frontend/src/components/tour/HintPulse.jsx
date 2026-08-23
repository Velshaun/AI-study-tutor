/**
 * A quiet dot on a feature nobody has met yet.
 *
 * The tap-to-open half of the two layers, and the half the research favours:
 * guidance somebody opens themselves completes far more often than guidance
 * that arrived on its own. It also costs nothing when ignored, which is what
 * makes it safe to put on ten things rather than three.
 *
 * Absolutely positioned against a `relative` parent, so it rides the corner of
 * whatever it marks without being in that thing's layout.
 */
export default function HintPulse({ onClick, label = 'What is this?' }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      aria-label={label}
      className="absolute -end-1 -top-1 z-10 flex size-4 items-center justify-center"
    >
      <span
        aria-hidden="true"
        className="absolute inline-flex size-4 rounded-full opacity-60 tour-pulse"
        style={{ background: 'rgb(108,99,255)' }}
      />
      <span
        aria-hidden="true"
        className="relative inline-flex size-2.5 rounded-full ring-2 ring-bg"
        style={{ background: 'rgb(108,99,255)' }}
      />
    </button>
  )
}
