import { Upload } from 'lucide-react'

/**
 * First-run empty state (§5.4).
 *
 * The illustration is inline SVG rather than an asset — it's a handful of
 * shapes, and keeping it in code means it inherits the theme tokens and flips
 * correctly between dark and light without a second file.
 */
export default function EmptyState({ onUpload }) {
  return (
    <div className="card flex flex-col items-center gap-6 py-12 text-center">
      <svg
        viewBox="0 0 120 100"
        className="h-28 w-32"
        role="img"
        aria-label="An empty stack of documents"
      >
        <rect x="26" y="30" width="52" height="64" rx="6"
              fill="var(--color-surface2)" stroke="var(--color-border)" strokeWidth="2"
              transform="rotate(-8 52 62)" />
        <rect x="38" y="24" width="52" height="64" rx="6"
              fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth="2" />
        <rect x="48" y="38" width="32" height="3" rx="1.5" fill="var(--color-border)" />
        <rect x="48" y="47" width="24" height="3" rx="1.5" fill="var(--color-border)" />
        <rect x="48" y="56" width="28" height="3" rx="1.5" fill="var(--color-border)" />
        <circle cx="88" cy="26" r="15" fill="var(--color-accent)" />
        <path d="M88 19v14M81 26h14" stroke="#fff" strokeWidth="2.5"
              strokeLinecap="round" />
      </svg>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-pri">Nothing here yet</h2>
        <p className="mx-auto max-w-xs text-sm text-sec">
          Upload a syllabus, lecture recording or set of notes. We&rsquo;ll work
          out which exam it is and build your study plan around the official
          weightings.
        </p>
      </div>

      <button onClick={onUpload} className="btn-primary">
        <Upload size={16} aria-hidden="true" />
        Upload your first source
      </button>
    </div>
  )
}
