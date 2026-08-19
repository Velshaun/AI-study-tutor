import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'

/**
 * A row that slides aside to reveal a delete action.
 *
 * Swipe left on a phone; on a pointer device the same zone opens on right-click
 * or a long press, because a mouse can't swipe and the action shouldn't be
 * reachable only by touch. The tile itself is untouched — this wraps it — so a
 * tap still opens the item and only a deliberate gesture arms the deletion.
 *
 * Nothing is deleted here: revealing is a gesture, deleting is a decision, so
 * `onDelete` runs only after the caller's confirmation.
 */

// Far enough that a scroll or a stray thumb doesn't arm it.
const REVEAL_PX = 72
const ARM_PX = 40
// Past this the gesture is a vertical scroll and the swipe gives way to it.
const VERTICAL_SLOP = 12

export default function SwipeToDelete({ label = 'item', onDelete, children }) {
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState(false)
  const start = useRef(null)
  const longPress = useRef(null)

  function reset() {
    setOffset(0)
    setOpen(false)
  }

  function onTouchStart(e) {
    const touch = e.touches[0]
    // `dx` is tracked here rather than read back from state at the end: a
    // quick flick fires move and end inside one tick, before React re-renders,
    // so the state value would still be zero and the swipe would snap back.
    start.current = { x: touch.clientX, y: touch.clientY, settled: false, dx: 0 }
  }

  function onTouchMove(e) {
    if (!start.current) return
    const touch = e.touches[0]
    const dx = touch.clientX - start.current.x
    const dy = touch.clientY - start.current.y

    // Let a vertical scroll win outright — the list has to stay scrollable.
    if (!start.current.settled) {
      if (Math.abs(dy) > VERTICAL_SLOP && Math.abs(dy) > Math.abs(dx)) {
        start.current = null
        return
      }
      if (Math.abs(dx) < 6) return
      start.current.settled = true
    }
    // Only leftwards, and never past the zone's width.
    const next = Math.max(-REVEAL_PX, Math.min(0, dx))
    start.current.dx = next
    setOffset(next)
  }

  function onTouchEnd() {
    if (!start.current) return
    const armed = start.current.dx <= -ARM_PX
    start.current = null
    setOffset(armed ? -REVEAL_PX : 0)
    setOpen(armed)
  }

  // Pointer devices: hold, or right-click, to reach the same zone.
  function onPointerDown(e) {
    if (e.pointerType === 'touch') return
    longPress.current = window.setTimeout(() => {
      setOffset(-REVEAL_PX)
      setOpen(true)
    }, 500)
  }
  function cancelLongPress() {
    if (longPress.current) {
      window.clearTimeout(longPress.current)
      longPress.current = null
    }
  }

  return (
    <div className="relative overflow-hidden rounded-2xl">
      {/* The zone sits behind the tile and is only reachable once revealed. */}
      <div className="absolute inset-y-0 right-0 flex w-[72px] items-center justify-center bg-warning">
        <button
          onClick={() => {
            onDelete?.()
            reset()
          }}
          tabIndex={open ? 0 : -1}
          aria-hidden={!open}
          aria-label={`Delete ${label}`}
          className="flex size-full items-center justify-center text-white"
        >
          <Trash2 size={20} aria-hidden="true" />
        </button>
      </div>

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onPointerDown={onPointerDown}
        onPointerUp={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onContextMenu={(e) => {
          e.preventDefault()
          setOffset(-REVEAL_PX)
          setOpen(true)
        }}
        // A tap anywhere on a revealed row closes it rather than opening the
        // item — the first tap after a swipe is nearly always "put that back".
        onClickCapture={(e) => {
          if (!open) return
          e.preventDefault()
          e.stopPropagation()
          reset()
        }}
        style={{ transform: `translateX(${offset}px)` }}
        className="relative transition-transform duration-200 ease-out"
      >
        {children}
      </div>
    </div>
  )
}
