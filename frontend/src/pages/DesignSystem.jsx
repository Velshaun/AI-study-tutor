/**
 * Design system reference — spec §5.1.
 *
 * Not a product screen. This renders every token and primitive defined in
 * index.css so the theme can be verified at a glance, and so later prompts
 * have a canonical reference for what already exists. Replace this route once
 * the real app shell lands.
 */

const SURFACES = [
  { name: 'bg', hex: '#0F0F0F', use: 'page background' },
  { name: 'surface', hex: '#1A1A1A', use: 'cards, panels' },
  { name: 'surface2', hex: '#242424', use: 'inputs, raised state' },
  { name: 'border', hex: '#2E2E2E', use: 'dividers, outlines' },
]

const ACCENTS = [
  { name: 'accent', hex: '#6C63FF', use: 'primary actions' },
  { name: 'accent2', hex: '#8B85FF', use: 'hover, emphasis' },
]

const TEXT = [
  { name: 'pri', hex: '#F0F0F0', use: 'headings, body' },
  { name: 'sec', hex: '#A0A0A0', use: 'meta, placeholders' },
]

const STATUS = [
  { name: 'success', hex: '#4CAF50', use: 'completed domains' },
  { name: 'warning', hex: '#FF9800', use: 'quota, retries' },
]

function Swatch({ name, hex, use }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="size-11 shrink-0 rounded-xl border border-border"
        style={{ backgroundColor: hex }}
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-pri">{name}</p>
        <p className="truncate text-xs text-sec">
          {hex} · {use}
        </p>
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-sec">
        {title}
      </h2>
      {children}
    </section>
  )
}

export default function DesignSystem() {
  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-3xl space-y-10 px-5 py-12">
        <header className="space-y-2">
          <span className="chip-accent">Design system</span>
          <h1 className="text-3xl font-semibold text-pri">AI Study Tutor</h1>
          <p className="text-sm text-sec">
            Dark-first theme, single purple accent. Tokens live in{' '}
            <code className="rounded bg-surface2 px-1.5 py-0.5 text-xs text-accent2">
              src/index.css
            </code>{' '}
            via Tailwind v4&rsquo;s <code className="text-accent2">@theme</code>.
          </p>
        </header>

        <Section title="Colour">
          <div className="card grid gap-5 sm:grid-cols-2">
            {[...SURFACES, ...ACCENTS, ...TEXT, ...STATUS].map((c) => (
              <Swatch key={c.name} {...c} />
            ))}
          </div>
        </Section>

        <Section title="Type — Inter">
          <div className="card space-y-3">
            <p className="text-3xl font-semibold text-pri">
              Design resilient architectures
            </p>
            <p className="text-base text-pri">
              A Trojan horse disguises itself as legitimate software, which is
              what separates it from a virus.
            </p>
            <p className="text-sm text-sec">
              Secondary text — timestamps, metadata and captions.
            </p>
            <p className="text-xs text-sec tabular-nums">
              domain 3 · 24% of exam · 7m 12s
            </p>
          </div>
        </Section>

        <Section title="Buttons">
          <div className="card flex flex-wrap gap-3">
            <button className="btn-primary">Generate lecture</button>
            <button className="btn-secondary">Upload source</button>
            <button className="btn-ghost">Skip</button>
            <button className="btn-primary" disabled>
              Disabled
            </button>
          </div>
        </Section>

        <Section title="Cards">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="card space-y-1.5">
              <p className="text-sm font-medium text-pri">Static card</p>
              <p className="text-sm text-sec">Panels and read-only surfaces.</p>
            </div>
            <div className="card-interactive space-y-1.5">
              <p className="text-sm font-medium text-pri">Interactive card</p>
              <p className="text-sm text-sec">
                Hover me — the border shifts to accent.
              </p>
            </div>
          </div>
        </Section>

        <Section title="Inputs & chips">
          <div className="card space-y-4">
            <input className="input" placeholder="Ask a question…" />
            <div className="flex flex-wrap gap-2">
              <span className="chip">locked</span>
              <span className="chip-accent">in progress</span>
              <span className="chip text-success">completed</span>
              <span className="chip text-warning">quota</span>
            </div>
          </div>
        </Section>

        <Section title="Loading">
          <div className="card space-y-3">
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-4 w-5/6" />
          </div>
        </Section>
      </div>
    </div>
  )
}
