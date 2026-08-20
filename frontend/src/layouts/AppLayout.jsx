import { useQuery } from '@tanstack/react-query'
import { Home, Settings, Star, Users } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'

import AddSourceButton from '../components/AddSourceButton'
import InstallPrompt from '../components/InstallPrompt'
import MiniPlayer from '../components/player/MiniPlayer'
import { api } from '../lib/api'
import { path, ROUTES } from '../routes'

/**
 * Shell for the main app screens.
 *
 * Mobile-first: a branded top bar plus a bottom tab bar. From `md` up both fold
 * into a sidebar that also lists the learner's modules with a persistent "Add
 * source" upload — so they can jump between modules or add another at any time,
 * never trapped after a first upload. The lecture player and onboarding wizard
 * sit outside this shell.
 */

const PROCESSING = ['processing', 'parsing', 'analysing', 'queued']

const TABS = [
  { to: ROUTES.dashboard, label: 'Home', Icon: Home, end: true },
  { to: ROUTES.favourites, label: 'Favourites', Icon: Star },
  { to: ROUTES.groups, label: 'Groups', Icon: Users },
  { to: ROUTES.settings, label: 'Settings', Icon: Settings },
]

/** Brand lockup: the ConverseAI mark + wordmark. */
function Wordmark({ className = '' }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <img
        src="/pwa-icon.svg"
        alt=""
        className="size-7 shrink-0 rounded-lg"
        width="28"
        height="28"
      />
      <span className="text-[15px] font-bold tracking-tight text-pri">
        Converse<span className="text-accent2">AI</span>
      </span>
    </span>
  )
}

function tabClass({ isActive }) {
  return [
    'flex flex-1 flex-col items-center gap-1 rounded-xl px-3 py-2',
    'text-[11px] font-medium transition-colors duration-150',
    'md:w-full md:flex-none md:flex-row md:gap-3 md:px-3 md:py-2.5 md:text-sm',
    isActive
      ? 'bg-accent/12 text-accent2'
      : 'text-sec hover:bg-surface2 hover:text-pri',
  ].join(' ')
}

/** The sidebar's module list + persistent upload (md+). */
function SidebarModules() {
  const { data } = useQuery({
    queryKey: ['modules'],
    queryFn: ({ signal }) => api.modules(signal),
    refetchInterval: (query) =>
      Array.isArray(query.state.data) &&
      query.state.data.some((m) => PROCESSING.includes(m.status))
        ? 4000
        : false,
  })
  const modules = Array.isArray(data) ? data : []

  return (
    <div className="mt-6 flex min-h-0 flex-1 flex-col">
      <p className="px-2 pb-2 text-[11px] font-bold uppercase tracking-wider text-sec">
        Modules
      </p>
      <div className="pb-2">
        <AddSourceButton />
      </div>
      <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
        {modules.length === 0 ? (
          <p className="px-2 py-1 text-xs text-sec">Upload a source to begin.</p>
        ) : (
          <nav className="flex flex-col gap-0.5">
            {modules.map((m) => (
              <NavLink
                key={m.id}
                to={path('module', { id: m.id })}
                className={({ isActive }) =>
                  [
                    'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors',
                    isActive
                      ? 'bg-accent/12 font-medium text-accent2'
                      : 'text-sec hover:bg-surface2 hover:text-pri',
                  ].join(' ')
                }
              >
                {PROCESSING.includes(m.status) && (
                  <span
                    className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                    aria-hidden="true"
                  />
                )}
                <span className="truncate">{m.title || 'Processing…'}</span>
              </NavLink>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}

export default function AppLayout() {
  return (
    <div className="min-h-dvh bg-bg md:flex">
      {/* Sidebar (md+) */}
      <aside className="hidden border-r border-border bg-surface md:flex md:h-dvh md:w-60 md:shrink-0 md:flex-col md:p-4 md:sticky md:top-0">
        <Wordmark className="px-2 pb-5 pt-2" />
        <nav className="flex flex-col gap-1">
          {TABS.map(({ to, label, Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={tabClass}>
              <Icon size={18} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <SidebarModules />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Branded top bar (mobile only) */}
        <header className="sticky top-0 z-30 flex items-center border-b border-border bg-surface/85 px-5 py-3 backdrop-blur md:hidden">
          <Wordmark />
        </header>

        {/* Content. Bottom padding clears the mobile tab bar and the home
            indicator on iOS; removed once the bar moves to the side at md. */}
        {/* `overflow-x-clip` rather than `hidden`: hidden creates a scroll
            container, which breaks `position: sticky` on descendants — the
            module tab bar among them. Clip contains the overflow without that
            side effect.

            Zooming shrinks the viewport in CSS pixels, so at 200% a phone is
            ~190px wide and anything with an intrinsic minimum — a wide table,
            a long unbroken filename — pushes the page sideways. min-w-0 lets
            these flex children shrink below their content instead. */}
        <main className="min-w-0 flex-1 overflow-x-clip pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">
          <div className="mx-auto w-full min-w-0 max-w-3xl px-5 py-8">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Minimised player, above the tab bar */}
      <MiniPlayer />

      {/* One-time "Add to Home Screen" prompt for signed-in learners */}
      <InstallPrompt />

      {/* Bottom tab bar (mobile) */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex gap-1 border-t border-border
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
