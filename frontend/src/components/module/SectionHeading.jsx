/**
 * A section title on the module screen.
 *
 * These were `text-xs uppercase` with wide tracking — smaller than the content
 * underneath them, which is backwards: a heading exists so the screen can be
 * skimmed, and one you have to stop and read is doing the opposite of its job.
 * The wide tracking was compensation for the size, and uppercase at a small
 * size is still small.
 *
 * So: sentence case at `text-base`, which is the change that actually fixes it.
 * The accent bar stays — it is what makes a section findable at a glance while
 * scrolling, which is the thing being complained about.
 *
 * A component rather than eight copies of a class string, because there were
 * eight copies and two of them had already drifted to different colours.
 */
const TONES = {
  accent: 'border-accent text-accent2',
  success: 'border-success text-success',
}

export default function SectionHeading({ Icon, tone = 'accent', action, children }) {
  return (
    <div className="flex items-center gap-2">
      <h2
        className={`flex min-w-0 flex-1 items-center gap-2 border-l-[3px] pl-3
                    text-base font-semibold ${TONES[tone] || TONES.accent}`}
      >
        {Icon && <Icon size={17} className="shrink-0" aria-hidden="true" />}
        <span className="truncate">{children}</span>
      </h2>
      {action}
    </div>
  )
}
