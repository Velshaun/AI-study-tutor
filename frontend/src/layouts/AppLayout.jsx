import { Home, Settings, Star, Users } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'

import InstallPrompt from '../components/InstallPrompt'
import MiniPlayer from '../components/player/MiniPlayer'

import { ROUTES } from '../routes'

/**
 * Shell for the main app screens.
 *
 * Mobile-first: a bottom tab bar, since this ships as an installed PWA where
 * thumb reach matters more than screen real estate. It promotes to a sidebar
 * from `md` up. The lecture player and onboarding wizard sit outside this
 * shell — both are immersive, single-purpose screens.
 */

const TABS = [
  { to: ROUTES.dashboard, label: 'Home', Icon: Home, end: true },
  { to: ROUTES.favourites, label: 'Favourites', Icon: Star },
  { to: ROUTES.groups, label: 'Groups', Icon: Users },
  { to: ROUTES.settings, label: 'Settings', Icon: Settings },
]

function tabClass({ isActive }) {
  return [
    'flex flex-1 flex-col items-center gap-1 rounded-xl px-3 py-2',
    'text-[11px] font-medium transition-colors duration-150',
    'md:w-full md:flex-none md:flex-row md:gap-3 md:px-3 md:py-2.5 md:text-sm',
    isActive ? 'text-accent2 md:bg-surface2' : 'text-sec hover:text-pri',
  ].join(' ')
}

export default function AppLayout() {
  return (
    <div className="min-h-dvh bg-bg md:flex">
      {/* Sidebar (md+) */}
      <aside className="hidden border-r border-border bg-surface md:flex md:w-60 md:shrink-0 md:flex-col md:gap-1 md:p-4">
        <p className="px-3 pb-4 pt-2 text-sm font-semibold text-pri">
          ConverseAI Tutor
        </p>
        <nav className="flex flex-col gap-1">
          {TABS.map(({ to, label, Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={tabClass}>
              <Icon size={18} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Content. Bottom padding clears the mobile tab bar and the home
          indicator on iOS; removed once the bar moves to the side at md. */}
      <main className="flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <div className="mx-auto max-w-3xl px-5 py-8">
          <Outlet />
        </div>
      </main>

      {/* Minimised player, above the tab bar */}
      <MiniPlayer />

      {/* One-time "Add to Home Screen" prompt for signed-in learners */}
      <InstallPrompt />

      {/* Bottom tab bar (mobile) */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border
                   bg-surface/95 px-2 pb-[env(safe-area-inset-bottom)] pt-1.5
                   backdrop-blur md:hidden"
      >
        {TABS.map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={tabClass}>
            <Icon size={20} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
