import { Hand, Headphones } from 'lucide-react'
import { useState } from 'react'

import { hasSeenAudioNotice, markAudioNoticeSeen } from '../../lib/audioNotice'
import Modal from '../Modal'

/**
 * What the two doors are, said once, before the first lecture.
 *
 * Not a permission gate and not a warning. It exists because the difference
 * between the two ways of asking is a fact about acoustics that nobody should
 * have to deduce: with headphones the tutor can be interrupted by speaking,
 * because the mic hears only you. Through a speaker the mic also hears the
 * tutor, so an interruption may not land — and the hand-raise is there for
 * exactly that.
 *
 * Saying it plainly costs one tap. Not saying it costs someone talking over a
 * lecture that carries on regardless, and concluding the feature is broken.
 *
 * Shown once and remembered. A notice that reappears is one people learn to
 * dismiss without reading, which would make it worse than absent.
 */

export default function HeadphonesNotice({ onAcknowledged }) {
  // Read once, at mount, rather than set from an effect: whether this has been
  // seen is known before the first render, so making it a state update after
  // one is both a wasted render and the cascading-render the repo forbids.
  const [open, setOpen] = useState(() => !hasSeenAudioNotice())

  const acknowledge = () => {
    markAudioNoticeSeen()
    setOpen(false)
    onAcknowledged?.()
  }

  return (
    <Modal open={open} title="Before you start" onClose={acknowledge}>
      <div className="space-y-3">
        <p className="text-sm leading-relaxed text-sec">
          You can ask questions during a lecture in two ways.
        </p>

        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface2 px-3 py-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent2">
            <Headphones size={16} aria-hidden="true" />
          </span>
          <p className="text-sm leading-relaxed text-pri">
            <span className="font-medium">With headphones</span>, just speak.
            The lecture pauses and you can interrupt the tutor mid-sentence,
            because your microphone only hears you.
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface2 px-3 py-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-sec">
            <Hand size={16} aria-hidden="true" />
          </span>
          <p className="text-sm leading-relaxed text-pri">
            <span className="font-medium">On a speaker</span>, use the hand
            button. Your microphone would otherwise pick up the tutor as well as
            you, so interrupting by voice isn&rsquo;t reliable. Raising your hand
            pauses the lecture and lets you type instead.
          </p>
        </div>

        <p className="text-xs leading-relaxed text-sec">
          Either way the answer is spoken aloud and written down, and the lecture
          picks up where it stopped.
        </p>

        <button onClick={acknowledge} className="btn-primary w-full">
          Got it — start the lecture
        </button>
      </div>
    </Modal>
  )
}
