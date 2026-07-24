/**
 * Scaffolding for a route that exists but isn't built yet.
 *
 * Deliberately shows the resolved route params — a route that silently renders
 * nothing looks identical to one that's mis-wired, and this makes `/module/:id`
 * picking up the wrong segment obvious immediately.
 *
 * Each of these is replaced wholesale by its real screen in a later prompt.
 */
export default function Placeholder({ title, description, params, prompt }) {
  const entries = Object.entries(params ?? {})

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold text-pri">{title}</h1>
        {description && <p className="text-sm text-sec">{description}</p>}
      </header>

      {entries.length > 0 && (
        <div className="card space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-sec">
            Route params
          </p>
          <dl className="space-y-1">
            {entries.map(([key, value]) => (
              <div key={key} className="flex gap-2 text-sm">
                <dt className="text-sec">{key}</dt>
                <dd className="truncate font-medium text-accent2">
                  {value ?? <span className="text-warning">undefined</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="card space-y-3">
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-4 w-1/2" />
        <div className="skeleton h-4 w-3/4" />
      </div>

      {prompt && (
        <p className="text-xs text-sec">
          Screen arrives in <span className="text-accent2">{prompt}</span>.
        </p>
      )}
    </div>
  )
}
