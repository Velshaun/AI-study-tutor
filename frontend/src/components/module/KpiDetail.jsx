import { useNavigate } from 'react-router-dom'

import Modal from '../Modal'
import MediaItemRow from './MediaItemRow'
import { path } from '../../routes'

/**
 * What a number is made of.
 *
 * A KPI reading "3 lectures" was a readout and nothing else, so the three
 * lectures it counted were somewhere below, mixed in with everything else the
 * module holds. This is the same three, on their own, one tap from the figure —
 * for browsing and revisiting, which is what a number you recognise is for.
 *
 * Grouped by domain, because that is how the Classroom is organised and a
 * second ordering would be a second mental model of the same material.
 *
 * The rows are `MediaItemRow`, the component the Classroom itself renders.
 * Deliberately not a lookalike: a filtered view of existing things cannot drift
 * out of sync with the things, and the first state either side gained — a
 * lecture still generating, a deck with a count — would otherwise show in one
 * list and not the other.
 */
export default function KpiDetail({ open, onClose, title, empty, kind, items = [] }) {
  const navigate = useNavigate()

  // Domain order is whatever the caller passed the items in — the studio
  // returns them in blueprint order, which is the order the Classroom lists
  // domains in, so grouping preserves it without sorting anything.
  const groups = []
  const byTitle = new Map()
  for (const item of items) {
    const name = item.domain_title || 'Everything else'
    if (!byTitle.has(name)) {
      const group = { name, items: [] }
      byTitle.set(name, group)
      groups.push(group)
    }
    byTitle.get(name).items.push(item)
  }

  function openItem(item) {
    onClose?.()
    if (kind === 'lecture') navigate(path('lecture', { id: item.id }))
    else if (kind === 'quiz') {
      navigate(`${path('quizzes', { domainId: item.domain_id })}?quiz=${item.id}`)
    }
  }

  return (
    <Modal open={open} title={title} onClose={onClose}>
      {groups.length === 0 ? (
        <p className="py-6 text-center text-sm text-sec">{empty}</p>
      ) : (
        <div className="-mx-1 max-h-[60vh] space-y-4 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.name}>
              <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sec">
                {group.name}
              </p>
              <ul className="rounded-xl bg-surface2">
                {group.items.map((item) => (
                  <MediaItemRow
                    key={item.id}
                    kind={kind}
                    item={item}
                    onOpen={openItem}
                    detail={item.__detail}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

