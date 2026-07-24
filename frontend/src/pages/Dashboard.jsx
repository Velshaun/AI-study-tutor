import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, LogIn, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import EmptyState from '../components/dashboard/EmptyState'
import KpiRow from '../components/dashboard/KpiRow'
import ModuleCard from '../components/dashboard/ModuleCard'
import ResumeCard from '../components/dashboard/ResumeCard'
import Modal from '../components/Modal'
import { api, ApiError } from '../lib/api'
import { ROUTES } from '../routes'

/**
 * Dashboard — spec §5.4.
 *
 * Two independent queries, so a slow module list doesn't hold up the KPI row
 * and each can retry on its own.
 *
 * Sign-in doesn't exist yet, so an auth failure gets its own state rather than
 * the error state. Treating "not signed in" as a server error would leave a
 * new visitor staring at a red box telling them to retry something that cannot
 * succeed.
 */
export default function Dashboard() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)

  const dashboardQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => api.dashboard(signal),
  })

  const modulesQuery = useQuery({
    queryKey: ['modules'],
    queryFn: ({ signal }) => api.modules(signal),
  })

  const create = useMutation({
    mutationFn: (title) => api.createModule({ title }),
    onSuccess: (module) => {
      queryClient.invalidateQueries({ queryKey: ['modules'] })
      setShowCreate(false)
      // Straight to the new module so they can add sources.
      navigate(`/module/${module.id}`)
    },
  })

  const openCreate = () => setShowCreate(true)

  const isLoading = dashboardQuery.isPending || modulesQuery.isPending
  const failure = dashboardQuery.error || modulesQuery.error
  const isAuthFailure = failure instanceof ApiError && failure.isAuth

  const state = isLoading
    ? 'loading'
    : isAuthFailure
      ? 'auth'
      : failure
        ? 'error'
        : 'ready'

  const data = dashboardQuery.data
  const modules = Array.isArray(modulesQuery.data) ? modulesQuery.data : []

  function retry() {
    dashboardQuery.refetch()
    modulesQuery.refetch()
  }

  if (state === 'loading') return <DashboardSkeleton />

  if (state === 'auth') {
    return (
      <Shell>
        <div className="card flex flex-col items-center gap-4 py-12 text-center">
          <LogIn size={28} className="text-accent" aria-hidden="true" />
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-pri">Sign in to continue</h2>
            <p className="mx-auto max-w-xs text-sm text-sec">
              Your modules and progress are tied to your account.
            </p>
          </div>
          <Link to={ROUTES.login} className="btn-primary">
            Sign in
          </Link>
        </div>
      </Shell>
    )
  }

  if (state === 'error') {
    return (
      <Shell>
        <div className="card flex flex-col items-center gap-4 py-12 text-center">
          <AlertCircle size={28} className="text-warning" aria-hidden="true" />
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-pri">
              Couldn&rsquo;t load your dashboard
            </h2>
            <p className="mx-auto max-w-sm text-sm text-sec">
              {failure?.message || 'Something went wrong.'}
            </p>
          </div>
          <button onClick={retry} className="btn-secondary">
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </button>
        </div>
      </Shell>
    )
  }

  const stats = data?.stats ?? {}
  const resume = data?.resume
  const isEmpty = modules.length === 0

  return (
    <Shell onNew={openCreate}>
      {isEmpty ? (
        <EmptyState onUpload={openCreate} />
      ) : (
        <>
          {resume && <ResumeCard resume={resume} />}

          <KpiRow stats={stats} />

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-sec">
              Your modules
            </h2>
            {/* Flex-centered rather than a 2-col grid so any count stays
                centered — a lone card would otherwise hug the left cell. */}
            <div className="flex flex-wrap justify-center gap-3">
              {modules.map((module) => (
                <div key={module.id} className="w-full sm:w-80">
                  <ModuleCard module={module} />
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* New Module FAB — mobile only. The md+ layout has room for a normal
          button in the header, where a floating one would overlap content. */}
      {!isEmpty && (
        <button
          onClick={openCreate}
          aria-label="New module"
          className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-5 z-30
                     flex size-14 items-center justify-center rounded-full bg-accent
                     text-white shadow-lg shadow-accent/25 transition-colors
                     hover:bg-accent2 md:hidden"
        >
          <Plus size={26} aria-hidden="true" />
        </button>
      )}

      <CreateModuleModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSubmit={create.mutate}
        pending={create.isPending}
        error={create.error?.message}
      />
    </Shell>
  )
}

function CreateModuleModal({ open, onClose, onSubmit, pending, error }) {
  const [title, setTitle] = useState('')
  return (
    <Modal open={open} title="New module" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim()) onSubmit(title.trim())
        }}
        className="space-y-4"
      >
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Module name (e.g. AWS Solutions Architect)"
          className="input"
        />
        {error && <p className="text-sm text-warning">{error}</p>}
        <button
          type="submit"
          disabled={pending || !title.trim()}
          className="btn-primary w-full"
        >
          {pending ? 'Creating…' : 'Create module'}
        </button>
      </form>
    </Modal>
  )
}

function Shell({ children, onNew }) {
  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-pri">Dashboard</h1>
          <p className="mt-0.5 text-sm text-sec">Your modules and progress.</p>
        </div>
        <button onClick={onNew} className="btn-primary hidden md:inline-flex">
          <Plus size={16} aria-hidden="true" />
          New module
        </button>
      </header>
      {children}
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading dashboard">
      <div className="skeleton h-8 w-40" />
      <div className="skeleton h-28 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-24 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-32 rounded-2xl" />
        ))}
      </div>
    </div>
  )
}
