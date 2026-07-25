import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2, LogIn, Plus, RefreshCw, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import ModuleCard from '../components/dashboard/ModuleCard'
import EmptyState from '../components/EmptyState'
import PageTitle from '../components/PageTitle'
import SectionHeader from '../components/SectionHeader'
import { UPLOAD_ACCEPT, useModuleUpload } from '../hooks/useModuleUpload'
import { api, ApiError } from '../lib/api'
import { ROUTES } from '../routes'

/**
 * Dashboard — spec §5.4 (revised).
 *
 * Just the modules: a clean, scannable list of cards, no KPI widgets (those now
 * live inside each module). Uploading a file creates and auto-names a module,
 * which appears here once processed. The list polls while anything is building.
 */

const PROCESSING = ['processing', 'parsing', 'analysing', 'queued']

export default function Dashboard() {
  const fileInput = useRef(null)
  const upload = useModuleUpload()

  const modulesQuery = useQuery({
    queryKey: ['modules'],
    queryFn: ({ signal }) => api.modules(signal),
    // Poll while any module is still being built so its name and progress land
    // without a manual refresh.
    refetchInterval: (query) =>
      Array.isArray(query.state.data) &&
      query.state.data.some((m) => PROCESSING.includes(m.status))
        ? 4000
        : false,
  })

  const openPicker = () => fileInput.current?.click()
  const handleFiles = (files) => {
    const list = Array.from(files || [])
    if (list.length) upload.mutate(list)
  }

  const error = modulesQuery.error
  const isAuth = error instanceof ApiError && error.isAuth
  const modules = useMemo(
    () => (Array.isArray(modulesQuery.data) ? modulesQuery.data : []),
    [modulesQuery.data],
  )

  // Most recently studied module (by its last-played lecture) — flagged with a
  // green outline. Nothing is flagged until something has actually been studied.
  const activeId = useMemo(() => {
    const played = modules.filter((m) => m.resume_last_played_at)
    if (!played.length) return null
    return played.reduce((a, b) =>
      new Date(b.resume_last_played_at) > new Date(a.resume_last_played_at) ? b : a,
    ).id
  }, [modules])

  const hiddenInput = (
    <input
      ref={fileInput}
      type="file"
      multiple
      accept={UPLOAD_ACCEPT}
      className="hidden"
      onChange={(e) => {
        handleFiles(e.target.files)
        e.target.value = ''
      }}
    />
  )

  if (modulesQuery.isPending) return <DashboardSkeleton />

  if (isAuth) {
    return (
      <Shell>
        <EmptyState
          centered
          icon={LogIn}
          title="Sign in to continue"
          message="Your modules are tied to your account."
          action={
            <Link to={ROUTES.login} className="btn-primary">
              Sign in
            </Link>
          }
        />
      </Shell>
    )
  }

  if (error) {
    return (
      <Shell>
        <EmptyState
          centered
          icon={AlertCircle}
          title="Couldn't load your modules"
          message={error.message || 'Something went wrong.'}
          action={
            <button onClick={() => modulesQuery.refetch()} className="btn-secondary">
              <RefreshCw size={15} aria-hidden="true" />
              Try again
            </button>
          }
        />
      </Shell>
    )
  }

  const isEmpty = modules.length === 0

  return (
    <Shell onUpload={openPicker}>
      {hiddenInput}

      {isEmpty ? (
        <UploadZone
          onPick={openPicker}
          onFiles={handleFiles}
          busy={upload.isPending}
        />
      ) : (
        <section className="space-y-4">
          <SectionHeader>Your modules</SectionHeader>
          {/* Full-width list — one card per row. */}
          <div className="space-y-3">
            {modules.map((module) => (
              <ModuleCard
                key={module.id}
                module={module}
                active={module.id === activeId}
              />
            ))}
          </div>
        </section>
      )}

      {/* Upload FAB — mobile only. The md+ layout uses the header + sidebar. */}
      {!isEmpty && (
        <button
          onClick={openPicker}
          aria-label="Upload a source"
          className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-5 z-30
                     flex size-14 items-center justify-center rounded-full bg-accent
                     text-white shadow-lg shadow-accent/25 transition-colors
                     hover:bg-accent2 md:hidden"
        >
          {upload.isPending ? (
            <Loader2 size={24} className="animate-spin" aria-hidden="true" />
          ) : (
            <Plus size={26} aria-hidden="true" />
          )}
        </button>
      )}
    </Shell>
  )
}

/**
 * First-run upload target: drag & drop or click. Depth counter keeps the
 * highlight steady while the cursor moves over the zone's own children.
 */
function UploadZone({ onPick, onFiles, busy }) {
  const depth = useRef(0)
  const [dragging, setDragging] = useState(false)

  function onDragEnter(e) {
    e.preventDefault()
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return
    depth.current += 1
    setDragging(true)
  }
  function onDragOver(e) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  function onDragLeave() {
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }
  function onDrop(e) {
    e.preventDefault()
    depth.current = 0
    setDragging(false)
    onFiles(e.dataTransfer.files)
  }

  return (
    <div className="flex min-h-[46vh] items-center justify-center">
      <button
        type="button"
        onClick={onPick}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={[
          'flex w-full max-w-md flex-col items-center gap-5 rounded-2xl border-2 px-6 py-16',
          'text-center transition-colors',
          dragging
            ? 'border-solid border-accent bg-accent/10'
            : 'border-dashed border-border hover:border-accent/50',
        ].join(' ')}
      >
        <div className="flex size-16 items-center justify-center rounded-2xl bg-accent/10 text-accent2">
          {busy ? (
            <Loader2 size={30} className="animate-spin" aria-hidden="true" />
          ) : (
            <Upload size={30} aria-hidden="true" />
          )}
        </div>
        <div className="space-y-1.5">
          <p className={`text-base font-semibold ${dragging ? 'text-accent2' : 'text-pri'}`}>
            {busy
              ? 'Building your module…'
              : dragging
                ? 'Drop to upload'
                : 'Drag & drop or click to upload'}
          </p>
          <p className="mx-auto max-w-xs text-sm leading-relaxed text-sec">
            {busy
              ? 'Reading your source and detecting the subject.'
              : 'Upload a syllabus, lecture recording or notes. We’ll detect the exam and build your study plan — no naming needed.'}
          </p>
        </div>
        {!busy && !dragging && (
          <span className="text-xs text-sec">PDF, audio (MP3, WAV, M4A) or text</span>
        )}
      </button>
    </div>
  )
}

function Shell({ children, onUpload }) {
  return (
    <div className="space-y-8">
      <PageTitle
        subtitle="Your study modules."
        actions={
          onUpload && (
            <button onClick={onUpload} className="btn-primary hidden md:inline-flex">
              <Upload size={16} aria-hidden="true" />
              Upload
            </button>
          )
        }
      >
        Dashboard
      </PageTitle>
      {children}
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading dashboard">
      <div className="skeleton h-8 w-40" />
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton h-28 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  )
}
