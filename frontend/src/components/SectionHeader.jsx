/**
 * A section label within a page ("Your modules", "Saved items", …).
 *
 * Smaller than the page title, in the accent colour with an accent left-rule so
 * it carries visual weight without competing with the heading. One component so
 * every section on every page reads the same.
 */
export default function SectionHeader({ children, actions, className = '' }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${className}`}>
      <h2 className="flex items-center border-l-2 border-accent pl-2.5 text-xs font-bold uppercase tracking-[0.14em] text-accent2">
        {children}
      </h2>
      {actions}
    </div>
  )
}
