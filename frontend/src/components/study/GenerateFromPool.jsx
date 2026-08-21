import { ClipboardList, FileText, Layers, Loader2 } from 'lucide-react'
import { useState } from 'react'

import Modal from '../Modal'

/**
 * Two dials: how many, and which ones.
 *
 * The same control wherever a pool of past questions can become something new —
 * inside a container, on a results screen, and from a historical session pill.
 * One component because they are one question, and three copies of a dial is
 * three chances for "the thirty oldest" to quietly mean something different.
 *
 * `sources` is only offered where there is a choice to make. A container is
 * already a single pool; a results screen has both missed and flagged, and
 * those are genuinely different requests.
 */

const MEDIA = [
  { id: 'practice_exam', label: 'Practice exam', Icon: FileText },
  { id: 'quiz', label: 'Quiz', Icon: ClipboardList },
  { id: 'flashcards', label: 'Flashcards', Icon: Layers },
]

const WHICH = [
  { id: 'recent', label: 'Most recent' },
  { id: 'oldest', label: 'Oldest' },
  { id: 'random', label: 'Random' },
]

export default function GenerateFromPool({
  open, onClose, onGenerate, busy = false,
  available = 0, sources = null, title = 'Generate from these',
  allowed = MEDIA.map((m) => m.id),
}) {
  const [media, setMedia] = useState('quiz')
  const [source, setSource] = useState('both')
  const [howMany, setHowMany] = useState('all')
  const [custom, setCustom] = useState('')
  const [which, setWhich] = useState('recent')

  // What the dials currently come to, shown before committing — "30 of your 91"
  // is the whole point of a dial, and a number that only appears afterwards is
  // a result rather than a control.
  const count =
    howMany === 'all'
      ? available
      : howMany === 'half'
        ? Math.ceil(available / 2)
        : Math.max(1, Math.min(Number(custom) || 0, available))

  const media_ = MEDIA.filter((m) => allowed.includes(m.id))

  return (
    <Modal open={open} title={title} onClose={busy ? undefined : onClose}>
      <div className="space-y-4">
        {sources && (
          <Field label="From">
            <Pills
              options={[
                { id: 'missed', label: `Missed (${sources.missed})` },
                { id: 'flagged', label: `Flagged (${sources.flagged})` },
                { id: 'both', label: `Both (${sources.both})` },
              ]}
              value={source}
              onChange={setSource}
            />
          </Field>
        )}

        <Field label="Make">
          <div className="grid grid-cols-3 gap-2">
            {media_.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMedia(id)}
                aria-pressed={media === id}
                className={`flex min-h-16 flex-col items-center justify-center gap-1
                            rounded-xl border px-2 py-2 text-[11px] transition-colors ${
                              media === id
                                ? 'border-accent bg-accent/10 text-accent2'
                                : 'border-border text-sec hover:border-accent/40'
                            }`}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="text-center leading-tight">{label}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="How many">
          <Pills
            options={[
              { id: 'all', label: 'Everything' },
              { id: 'half', label: 'Half' },
              { id: 'custom', label: 'A number' },
            ]}
            value={howMany}
            onChange={setHowMany}
          />
          {howMany === 'custom' && (
            <div className="flex items-center gap-2 pt-2">
              {/* Typed or scrubbed — a range alone can't hit an exact 30 out of
                  91 on a phone, and a box alone is fiddly for a rough half. */}
              <input
                type="range"
                min={1}
                max={Math.max(1, available)}
                value={Math.min(Number(custom) || 1, available)}
                onChange={(e) => setCustom(e.target.value)}
                className="min-w-0 flex-1 accent-accent"
                aria-label="How many questions"
              />
              <input
                type="number"
                min={1}
                max={available}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="30"
                className="input w-20 shrink-0 text-center"
                aria-label="How many questions, typed"
              />
            </div>
          )}
        </Field>

        <Field label="Which ones">
          <Pills options={WHICH} value={which} onChange={setWhich} />
        </Field>

        <p className="text-xs text-sec">
          {available === 0
            ? 'Nothing in here yet.'
            : `${count} of your ${available} question${available === 1 ? '' : 's'}.`}
        </p>

        <div className="flex gap-2">
          <button onClick={onClose} disabled={busy}
                  className="btn-secondary flex-1 py-2 text-xs">
            Cancel
          </button>
          <button
            disabled={busy || !available || (howMany === 'custom' && !Number(custom))}
            onClick={() =>
              onGenerate({
                media,
                source,
                which,
                how_many: howMany === 'custom' ? Number(custom) : howMany,
              })
            }
            className="btn-primary flex-1 py-2 text-xs"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              'Generate'
            )}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function Field({ label, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-sec">
        {label}
      </span>
      <span className="block">{children}</span>
    </label>
  )
}

function Pills({ options, value, onChange }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={`min-h-9 rounded-lg px-2.5 text-xs transition-colors ${
            value === option.id
              ? 'bg-accent text-white'
              : 'bg-surface2 text-sec hover:text-pri'
          }`}
        >
          {option.label}
        </button>
      ))}
    </span>
  )
}
