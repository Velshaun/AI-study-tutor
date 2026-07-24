import { Check } from 'lucide-react'

/**
 * Radio-group of cards, used by the length, difficulty and theme steps.
 *
 * Rendered as real radio inputs rather than buttons so arrow keys move between
 * options and screen readers announce it as one group with a position — which
 * a set of `aria-pressed` buttons does not.
 */
export default function OptionCards({ name, label, options, value, onChange, columns = 3 }) {
  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">{label}</legend>
      <div
        className={[
          'grid gap-3',
          columns === 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-3',
        ].join(' ')}
      >
        {options.map((option) => {
          const selected = value === option.id
          return (
            <label
              key={option.id}
              className={[
                'card-interactive cursor-pointer',
                selected ? 'border-accent bg-surface2' : '',
              ].join(' ')}
            >
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={selected}
                onChange={() => onChange(option.id)}
                className="sr-only"
              />
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-pri">{option.label}</p>
                  {option.hint && (
                    <p className="mt-0.5 text-xs text-sec">{option.hint}</p>
                  )}
                </div>
                {selected && (
                  <Check size={16} className="shrink-0 text-accent" aria-hidden="true" />
                )}
              </div>
              {option.description && (
                <p className="mt-2 text-xs text-sec">{option.description}</p>
              )}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
