import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2, LogIn, Plus, RefreshCw, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import KpiRow from '../components/dashboard/KpiRow'
import ModuleCard from '../components/dashboard/ModuleCard'
import ResumeCard from '../components/dashboard/ResumeCard'
import EmptyState from '../components/EmptyState'
import PageTitle from '../components/PageTitle'
import SectionHeader from '../components/SectionHeader'
import { api, ApiError } from '../lib/api'
import { useToast } from '../hooks/useToast'
import { ROUTES } from '../routes'

/**
 * Dashboard — spec §5.4.
 *
 * Modules are created by *uploading*, never by a form: dropping or picking a
 * file creates a module, attaches the source and kicks off the pipeline, which
 * auto-names the module from the detected subject. The learner never types a
 * name (they can rename later, on the card). The module list polls while
 * anything is processing so the AI name and "ready" state land on their own.
 */

const PROCESSING = ['processing', 'parsing', 'analysing', 'queued']
const ACCEPT = '.pdf,.txt,.md,.mp3,.wav,.m4a,.mp4,.ogg,.webm,.flac,.mpga'

export default function Dashboard() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const fileInput = useRef(null)

  const dashboardQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => api.dashboard(signal),
  })

  const modulesQuery = useQuery({
    queryKey: ['modules'],
    queryFn: ({ signal }) => api.modules(signal),
    // Poll while any module is still being built, so its AI-generated name and
    // ready state appear without a manual refresh.
    refetchInterval: (query) =>
      Array.isArray(query.state.data) &&
      query.state.data.some((m) => PROCESSING.includes(m.status))
        ? 4000
        : false,
  })

  // Upload = create module → attach sources → start pipeline. One action, no
  // name prompt. The backend names the module from the detected subject.
  const upload = useMutation({
    mutationFn: async (files) => {
      const list = Array.from(files || [])
      if (!list.length) return null
      const module = await api.createModule()
      await api.uploadSources(module.id, list)
      await api.processModule(module.id)
      return module
    },
    onSuccess: (module) => {
      queryClient.invalidateQueries({ queryKey: ['modules'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      if (module) toast.success('Upload received — building your module…')
    },
    onError: (e) => toast.error(e?.message || 'Upload failed. Please try again.'),
  })

  const openPicker = () => fileInput.current?.click()
  const handleFiles = (files) => {
    const list = Array.from(files || [])
    if (list.length) upload.mutate(list)
  }

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

  // One hidden input drives every upload entry point (empty zone, header, FAB).
  const hiddenInput = (
    <input
      ref={fileInput}
      type="file"
      multiple
      accept={ACCEPT}
      className="hidden"
      onChange={(e) => {
        handleFiles(e.target.files)
        e.target.value = ''
      }}
    />
  )

  if (state === 'loading') return <DashboardSkeleton />

  if (state === 'auth') {
    return (
      <Shell>
        <EmptyState
          centered
          icon={LogIn}
          title="Sign in to continue"
          message="Your modules and progress are tied to your account."
          action={
            <Link to={ROUTES.login} className="btn-primary">
              Sign in
            </Link>
          }
        />
      </Shell>
    )
  }

  if (state === 'error') {
    return (
      <Shell>
        <EmptyState
          centered
          icon={AlertCircle}
          title="Couldn't load your dashboard"
          message={failure?.message || 'Something went wrong.'}
          action={
            <button onClick={retry} className="btn-secondary">
              <RefreshCw size={15} aria-hidden="true" />
              Try again
            </button>
          }
        />
      </Shell>
    )
  }

  const stats = data?.stats ?? {}
  const resume = data?.resume
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
        <>
          {resume && <ResumeCard resume={resume} />}

          <KpiRow stats={stats} />

          <section className="space-y-4">
            <SectionHeader>Your modules in progress</SectionHeader>
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

      {/* Upload FAB — mobile only. The md+ layout uses the header button. */}
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
        subtitle="Your modules and progress."
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
