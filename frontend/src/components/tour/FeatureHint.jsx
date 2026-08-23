import Spotlight from './Spotlight'
import TourCard from './TourCard'
import HintPulse from './HintPulse'
import { useFeatureHint } from '../../hooks/useFeatureHint'

/**
 * One contextual moment, wired: the pulse, the spotlight and the card.
 *
 * Callers place this next to the thing it teaches and hand it a selector.
 * Everything about whether it has been seen, and whether it opens itself or
 * waits to be tapped, lives in the registry rather than at the call site — so
 * changing a moment from automatic to opt-in is one line in `lib/tour`, not a
 * hunt through components.
 */
export default function FeatureHint({ id, target, ready = true, radius }) {
  const hint = useFeatureHint(id, ready)
  if (!hint.moment) return null

  return (
    <>
      {hint.armed && <HintPulse onClick={hint.show} label={hint.moment.title} />}
      {hint.open && (
        <>
          <Spotlight target={target} radius={radius} onBackdrop={hint.dismiss} />
          <TourCard
            target={target}
            title={hint.moment.title}
            body={hint.moment.body}
            step={0}
            total={1}
            onNext={hint.dismiss}
            onSkip={hint.dismiss}
          />
        </>
      )}
    </>
  )
}
