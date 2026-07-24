import { motion } from 'framer-motion'
import { Share, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useAuth } from '../hooks/useAuth'

/**
 * "Add to Home Screen" prompt — spec Prompt 10 (item 3).
 *
 * Shown to a signed-in learner once, deferring to the platform's own flow:
 *  - Chromium/Android fires `beforeinstallprompt`; we stash it and trigger the
 *    native chooser from our own button (browsers no longer auto-show it).
 *  - iOS Safari has no such event, so we show the manual Share → Add steps.
 *
 * A dismissal (or a completed install) is remembered in localStorage so it
 * never nags twice.
 */

const DISMISS_KEY = 'a2hs-dismissed'

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  )
}

function isIos() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent)
}

export default function InstallPrompt() {
  const { isAuthenticated } = useAuth()
  const [deferred, setDeferred] = useState(null)
  // Lazy initial state (not a setState-in-effect): decide iOS eligibility once.
  const [iosEligible] = useState(
    () =>
      isIos() &&
      !isStandalone() &&
      localStorage.getItem(DISMISS_KEY) !== '1' &&
      // Only Safari can add to the home screen on iOS.
      /safari/i.test(window.navigator.userAgent) &&
      !/crios|fxios/i.test(window.navigator.userAgent),
  )

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISS_KEY) === '1') return undefined
    const onPrompt = (e) => {
      e.preventDefault() // keep the native mini-infobar from showing
      setDeferred(e)
    }
    const onInstalled = () => {
      localStorage.setItem(DISMISS_KEY, '1')
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const [dismissed, setDismissed] = useState(false)
  const show = isAuthenticated && !dismissed && (deferred || iosEligible)
  if (!show) return null

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  async function install() {
    if (!deferred) return
    deferred.prompt()
    await deferred.userChoice.catch(() => {})
    localStorage.setItem(DISMISS_KEY, '1')
    setDeferred(null)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed inset-x-0 z-50 mx-auto max-w-md px-4
                 bottom-[calc(5.5rem+env(safe-area-inset-bottom))]
                 md:bottom-[calc(1.5rem+env(safe-area-inset-bottom))]"
      role="dialog"
      aria-label="Install AI Study Tutor"
    >
      <div className="flex items-start gap-3 rounded-2xl border border-border bg-surface2 p-4 shadow-xl">
        <img src="/pwa-icon.svg" alt="" className="size-11 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-pri">Add to your home screen</p>
          {deferred ? (
            <p className="mt-0.5 text-xs text-sec">
              Install AI Study Tutor for full-screen study and offline access.
            </p>
          ) : (
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-sec">
              Tap
              <Share size={13} className="inline text-accent2" aria-hidden="true" />
              then
              <span className="inline-flex items-center gap-0.5 font-medium text-pri">
                <Plus size={12} aria-hidden="true" /> Add to Home Screen
              </span>
            </p>
          )}
          {deferred && (
            <button onClick={install} className="btn-primary mt-3 h-10 w-full text-sm">
              Install
            </button>
          )}
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="btn-ghost -mr-1 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-full p-0"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </motion.div>
  )
}
