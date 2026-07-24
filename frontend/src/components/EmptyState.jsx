/**
 * A styled empty state — icon (or illustration), message, optional call to
 * action. Vertically roomy so it sits as a considered block, never blank space.
 *
 * Pass `centered` when it's the main content of a screen: it then floats in the
 * middle of the available height with breathing room above and below rather
 * than hugging whatever sits above it.
 */
export default function EmptyState({
  icon: Icon,
  title,
  message,
  action,
  illustration,
  centered = false,
}) {
  const card = (
    <div className="card flex w-full flex-col items-center gap-5 px-6 py-14 text-center">
      {illustration ? (
        illustration
      ) : Icon ? (
        <div className="flex size-16 items-center justify-center rounded-2xl bg-accent/10 text-accent2">
          <Icon size={28} aria-hidden="true" />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold text-pri">{title}</h2>
        {message && (
          <p className="mx-auto max-w-xs text-sm leading-relaxed text-sec">
            {message}
          </p>
        )}
      </div>

      {action}
    </div>
  )

  if (!centered) return card
  return (
    <div className="flex min-h-[46vh] items-center justify-center py-4">{card}</div>
  )
}
