import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Download,
  FileJson,
  FileText,
  Loader2,
  MessageCircle,
  MoreVertical,
  Plus,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import Modal from '../components/Modal'
import AddSourceSheet from '../components/module/AddSourceSheet'
import ChatTab from '../components/module/ChatTab'
import ClassroomTab from '../components/module/ClassroomTab'
import CourseContextCard from '../components/module/CourseContextCard'
import CsvFlashcardImportModal from '../components/module/CsvFlashcardImportModal'
import ImportedExamsCard from '../components/module/ImportedExamsCard'
import SourcesTab from '../components/module/SourcesTab'
import PageTitle from '../components/PageTitle'
import { useGoBack } from '../hooks/useGoBack'
import ErrorBanner from '../components/ErrorBanner'
import { useConfirm } from '../hooks/useConfirm'
import { useToast } from '../hooks/useToast'
import { ApiError, api } from '../lib/api'
import { removeModuleFromCaches } from '../lib/modules'
import { ROUTES } from '../routes'

/**
 * Module detail — the hub that create/upload/process/study/share/export all
 * hang off (the screen flagged as the keystone across Prompts 7-9).
 *
 * While the pipeline runs, the module + sources queries poll every 4 seconds —
 * the established pattern that mirrors a real client and catches concurrency
 * bugs. Polling stops once the module reaches a terminal state.
 */

const PROCESSING = ['processing', 'parsing', 'analysing', 'queued']

const TABS = ['sources', 'chat', 'classroom']

export default function ModuleDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  // Unguarded navigate(-1) walks out of the app when this page was the
  // first one opened — a shared link, or a refresh.
  const goBack = useGoBack(ROUTES.dashboard)
  const toast = useToast()
  const queryClient = useQueryClient()
  // ?tab= lets another screen land on the right tab — the lecture player sends
  // an unopenable lecture back to Classroom, where its tile is.
  const [search] = useSearchParams()
  const requested = search.get('tab')
  // Arriving from the dashboard's CSV route, which had to create this module
  // before it had anywhere to put a deck.
  const wantsCsv = search.get('csv') === '1'
  const [tab, setTab] = useState(() =>
    TABS.includes(requested) ? requested : 'sources',
  )
  const [showAdd, setShowAdd] = useState(false)
  // Seeded from the URL rather than synced in an effect: the repo's
  // react-hooks rules forbid setState in an effect body, and this only ever
  // matters on the first render anyway.
  const [showCsv, setShowCsv] = useState(wantsCsv)

  const rename = useMutation({
    mutationFn: (title) => api.renameModule(id, title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['module', id] })
      queryClient.invalidateQueries({ queryKey: ['modules'] })
    },
    onError: (e) => toast.error(e?.message || 'Could not rename the module'),
  })

  const moduleQuery = useQuery({
    queryKey: ['module', id],
    queryFn: ({ signal }) => api.module(id, signal),
    refetchInterval: (query) =>
      PROCESSING.includes(query.state.data?.status) ? 4000 : false,
  })

  const sourcesQuery = useQuery({
    queryKey: ['sources', id],
    queryFn: ({ signal }) => api.sources(id, signal),
    refetchInterval: () =>
      PROCESSING.includes(moduleQuery.data?.status) ? 4000 : false,
  })

  // Record the open for the dashboard's "Last visited" section. Once per module
  // (not on each poll), and best-effort — a failed touch never blocks the view.
  useEffect(() => {
    api.touchModule(id).catch(() => {})
  }, [id])

  // Announce the moment processing finishes — the learner may be on another
  // screen when the pipeline completes, so it's a genuine "it's ready" beat.
  const prevStatus = useRef(null)
  const status = moduleQuery.data?.status
  useEffect(() => {
    if (PROCESSING.includes(prevStatus.current) && status === 'ready') {
      toast.success('Module ready!')
    }
    if (PROCESSING.includes(prevStatus.current) && status === 'failed') {
      toast.error('Processing failed. Check your sources and try again.')
    }
    prevStatus.current = status
  }, [status, toast])

  if (moduleQuery.isPending) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-40 rounded-2xl" />
      </div>
    )
  }

  if (moduleQuery.error) {
    const isAuth = moduleQuery.error instanceof ApiError && moduleQuery.error.isAuth
    return (
      <div className="card flex flex-col items-center gap-4 py-12 text-center">
        <AlertCircle size={26} className="text-warning" aria-hidden="true" />
        <p className="text-sm text-sec">
          {isAuth ? 'Sign in to view this module.' : 'Module not found.'}
        </p>
        <button onClick={() => navigate(ROUTES.dashboard)} className="btn-secondary">
          Back to dashboard
        </button>
      </div>
    )
  }

  const module = moduleQuery.data
  const sources = Array.isArray(sourcesQuery.data) ? sourcesQuery.data : []
  const domains = module.domains || []
  const ready = module.status === 'ready'

  return (
    <div className="space-y-6 pb-28 md:pb-32">
      <PageTitle
        onBack={goBack}
        onRename={(title) => rename.mutate(title)}
        subtitle={
          module.detected_subject ||
          (module.status === 'failed'
            ? module.error_message || 'Processing failed'
            : PROCESSING.includes(module.status)
              ? 'Working on your study plan…'
              : 'Add sources to get started')
        }
        actions={
          <ModuleMenu module={module} onDeleted={() => navigate(ROUTES.dashboard)} />
        }
      >
        {module.title}
      </PageTitle>

      {tab === 'sources' ? (
        <div className="space-y-6">
          <SourcesTab moduleId={id} sources={sources} />
          <CourseContextCard moduleId={id} />
        </div>
      ) : tab === 'chat' ? (
        <ChatTab moduleId={id} />
      ) : ready ? (
        <div className="space-y-6">
          <ClassroomTab
            moduleId={id}
            moduleTitle={module.title}
            domains={domains}
            examCount={module.practice_question_count || 40}
          />
          <ImportedExamsCard moduleId={id} />
        </div>
      ) : (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <Loader2 size={24} className="animate-spin text-accent" aria-hidden="true" />
          <p className="text-sm text-sec">
            Your module is still being built. Check the Sources tab for progress.
          </p>
        </div>
      )}

      {/* Fixed bottom: Add-a-source (Sources tab) + the tab bar */}
      <ModuleTabBar
        tab={tab}
        onChange={setTab}
        onAddSource={() => setShowAdd(true)}
      />

      <AddSourceSheet
        onError={(m) => toast.error(m)}
        open={showAdd}
        moduleId={id}
        onClose={() => setShowAdd(false)}
        onImportCsv={() => {
          setShowAdd(false)
          setShowCsv(true)
        }}
      />
      <CsvFlashcardImportModal
        open={showCsv}
        moduleId={id}
        onClose={() => setShowCsv(false)}
      />
    </div>
  )
}

/* --- fixed bottom tab bar (Sources / Studio) ----------------------------- */
function ModuleTabBar({ tab, onChange, onAddSource }) {
  return (
    <div
      className="fixed inset-x-0 z-30 px-5
                 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-4 md:left-60"
    >
      <div className="mx-auto max-w-3xl space-y-2">
        {tab === 'sources' && (
          <button
            onClick={onAddSource}
            className="flex w-full items-center justify-center gap-2 rounded-xl border
                       border-dashed border-border bg-surface/95 px-3 py-3 text-sm
                       font-medium text-sec backdrop-blur transition-colors
                       hover:border-accent/50 hover:text-pri"
          >
            <Plus size={16} aria-hidden="true" />
            Add a source
          </button>
        )}
        <div className="flex gap-1 rounded-2xl border border-border bg-surface/95 p-1 shadow-lg backdrop-blur">
          <TabButton
            active={tab === 'sources'}
            onClick={() => onChange('sources')}
            Icon={FileText}
            label="Sources"
          />
          <TabButton
            active={tab === 'chat'}
            onClick={() => onChange('chat')}
            Icon={MessageCircle}
            label="Chat"
          />
          <TabButton
            active={tab === 'classroom'}
            onClick={() => onChange('classroom')}
            Icon={Sparkles}
            label="Classroom"
          />
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5',
        'text-sm font-medium transition-colors',
        active ? 'bg-accent/12 text-accent2' : 'text-sec hover:bg-surface2 hover:text-pri',
      ].join(' ')}
    >
      <Icon size={16} aria-hidden="true" />
      {label}
    </button>
  )
}

/* --- actions menu (export / share / delete) ------------------------------ */
function ModuleMenu({ module, onDeleted }) {
  const confirm = useConfirm()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [showShare, setShowShare] = useState(false)

  // Deleting a module also clears its storage objects, which takes the server
  // several seconds. Waiting for that leaves the card sitting on the dashboard
  // as though nothing happened, so the card goes now and comes back only if the
  // server actually refuses.
  const del = useMutation({
    mutationFn: () => api.deleteModule(module.id),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['modules'] })
      await queryClient.cancelQueries({ queryKey: ['dashboard'] })
      const previous = {
        modules: queryClient.getQueryData(['modules']),
        dashboard: queryClient.getQueryData(['dashboard']),
      }
      removeModuleFromCaches(queryClient, module.id)
      toast.success('Module deleted')
      onDeleted()
      return previous
    },
    onError: (_e, _vars, previous) => {
      // Put it back exactly as it was, and say so plainly.
      if (previous?.modules !== undefined) {
        queryClient.setQueryData(['modules'], previous.modules)
      }
      if (previous?.dashboard !== undefined) {
        queryClient.setQueryData(['dashboard'], previous.dashboard)
      }
      toast.error('Could not delete module. Please try again.')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['modules'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  const filename = (module.title || 'module').toLowerCase().replace(/[^a-z0-9]+/g, '-')

  async function exportAs(kind) {
    setOpen(false)
    try {
      if (kind === 'json') {
        await api.exportModuleJson(module.id, `${filename}.json`)
      } else {
        await api.exportModulePdf(module.id, `${filename}.pdf`)
      }
      toast.success('Export downloaded')
    } catch (e) {
      toast.error(e?.message || 'Export failed')
    }
  }

  async function confirmDelete() {
    setOpen(false)
    const ok = await confirm({
      title: 'Delete module?',
      message: `"${module.title}" and all its lectures, quizzes and cards will be permanently removed.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) del.mutate()
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Module actions"
        className="btn-ghost size-11 rounded-full p-0"
      >
        <MoreVertical size={18} aria-hidden="true" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-52 rounded-xl border border-border bg-surface p-1 shadow-lg">
            <MenuItem
              Icon={FileJson}
              label="Export as JSON"
              onClick={() => exportAs('json')}
            />
            <MenuItem
              Icon={Download}
              label="Export as PDF"
              onClick={() => exportAs('pdf')}
            />
            <MenuItem
              Icon={Share2}
              label="Share to a group"
              onClick={() => {
                setShowShare(true)
                setOpen(false)
              }}
            />
            <div className="my-1 h-px bg-border" />
            <MenuItem
              Icon={Trash2}
              label="Delete module"
              danger
              onClick={confirmDelete}
            />
          </div>
        </>
      )}

      <ShareModal open={showShare} module={module} onClose={() => setShowShare(false)} />
    </div>
  )
}

function MenuItem({ Icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors',
        danger ? 'text-warning hover:bg-warning/10' : 'text-pri hover:bg-surface2',
      ].join(' ')}
    >
      <Icon size={15} aria-hidden="true" />
      {label}
    </button>
  )
}

/* --- share a domain to a group ------------------------------------------- */
function ShareModal({ open, module, onClose }) {
  // Every domain is shareable. This filtered out locked ones, which was every
  // domain past the first — so sharing a module shared a fifth of it.
  const domains = (module.domains || []).filter((d) => !d.is_imported_deck)

  const { data: groups } = useQuery({
    queryKey: ['groups'],
    queryFn: ({ signal }) => api.groups(signal),
    enabled: open,
  })

  const [domainId, setDomainId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [done, setDone] = useState(false)

  const share = useMutation({
    mutationFn: () =>
      api.shareDomain(groupId, {
        domain_id: domainId,
        share_lecture: true,
        share_qa: false,
      }),
    onSuccess: () => setDone(true),
  })

  const ownedGroups = (groups || []).filter((g) => g.is_owner)

  return (
    <Modal open={open} title="Share a domain" onClose={onClose}>
      {done ? (
        <div className="space-y-4 text-center">
          <p className="text-sm text-pri">Shared. Members can now study it.</p>
          <button onClick={onClose} className="btn-primary w-full">
            Done
          </button>
        </div>
      ) : ownedGroups.length === 0 ? (
        <p className="text-sm text-sec">
          You need to own a group first. Create one from the Groups tab.
        </p>
      ) : domains.length === 0 ? (
        <p className="text-sm text-sec">
          This module has no unlocked domains to share yet.
        </p>
      ) : (
        <div className="space-y-4">
          <Field label="Domain">
            <select
              value={domainId}
              onChange={(e) => setDomainId(e.target.value)}
              className="input"
            >
              <option value="">Choose a domain…</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Group">
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="input"
            >
              <option value="">Choose a group…</option>
              {ownedGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <ErrorBanner message={share.error?.message} onDismiss={share.reset} />
          <button
            onClick={() => share.mutate()}
            disabled={!domainId || !groupId || share.isPending}
            className="btn-primary w-full"
          >
            {share.isPending ? 'Sharing…' : 'Share'}
          </button>
        </div>
      )}
    </Modal>
  )
}

function Field({ label, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-sec">{label}</span>
      {children}
    </label>
  )
}
