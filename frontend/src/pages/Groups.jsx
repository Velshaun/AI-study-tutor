import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, LogIn, MessageSquare, Plus, Users } from 'lucide-react'
import { useState } from 'react'

import EmptyState from '../components/EmptyState'
import Modal from '../components/Modal'
import PageTitle from '../components/PageTitle'
import SectionHeader from '../components/SectionHeader'
import Toggle from '../components/Toggle'
import { useAuth } from '../hooks/useAuth'
import { api, ApiError } from '../lib/api'

/**
 * Study groups & sharing — spec Prompt 8.2.
 *
 * A list of the caller's groups, create/join modals, and an inline detail view
 * with members and shared domains. Owners get lecture/Q&A share toggles per
 * domain; invitees get a "show Q&A" toggle that only takes effect where the
 * owner has enabled Q&A sharing.
 */
export default function Groups() {
  const [openGroup, setOpenGroup] = useState(null)

  if (openGroup) {
    return <GroupDetail groupId={openGroup} onBack={() => setOpenGroup(null)} />
  }
  return <GroupList onOpen={setOpenGroup} />
}

/* --- list ---------------------------------------------------------------- */
function GroupList({ onOpen }) {
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [showJoin, setShowJoin] = useState(false)

  const { data, isPending, error } = useQuery({
    queryKey: ['groups'],
    queryFn: ({ signal }) => api.groups(signal),
  })

  const create = useMutation({
    mutationFn: (name) => api.createGroup({ name }),
    onSuccess: (group) => {
      queryClient.invalidateQueries({ queryKey: ['groups'] })
      setShowCreate(false)
      onOpen(group.id)
    },
  })

  const join = useMutation({
    mutationFn: (code) => api.joinGroup(code),
    onSuccess: (group) => {
      queryClient.invalidateQueries({ queryKey: ['groups'] })
      setShowJoin(false)
      onOpen(group.id)
    },
  })

  const groups = Array.isArray(data) ? data : []
  const isAuth = error instanceof ApiError && error.isAuth

  return (
    <div className="space-y-6">
      <PageTitle subtitle="Study together and share domains.">Groups</PageTitle>

      {isPending ? (
        <div className="space-y-3" role="status" aria-label="Loading">
          <div className="skeleton h-16 rounded-2xl" />
          <div className="skeleton h-16 rounded-2xl" />
        </div>
      ) : isAuth ? (
        <EmptyState
          centered
          icon={Users}
          title="Sign in to see your groups"
          message="Your groups and shared domains are tied to your account."
        />
      ) : (
        <>
          {/* Join / Create — the only place these buttons live now. */}
          <div className="flex gap-2">
            <button onClick={() => setShowJoin(true)} className="btn-secondary">
              <LogIn size={16} aria-hidden="true" />
              Join
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary">
              <Plus size={16} aria-hidden="true" />
              Create Group
            </button>
          </div>

          {groups.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No groups yet"
              message="Create a group to share your domains, or join one with an invite code."
            />
          ) : (
            <div className="space-y-3">
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => onOpen(g.id)}
              className="card-interactive flex w-full items-center gap-3 text-left"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent2">
                <Users size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-pri">{g.name}</p>
                <p className="text-xs text-sec">
                  {g.member_count} member{g.member_count === 1 ? '' : 's'}
                  {g.is_owner && ' · you own this'}
                </p>
              </div>
            </button>
          ))}
            </div>
          )}
        </>
      )}

      <CreateModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSubmit={create.mutate}
        pending={create.isPending}
        error={create.error?.message}
      />
      <JoinModal
        open={showJoin}
        onClose={() => setShowJoin(false)}
        onSubmit={join.mutate}
        pending={join.isPending}
        error={join.error?.message}
      />
    </div>
  )
}

function CreateModal({ open, onClose, onSubmit, pending, error }) {
  const [name, setName] = useState('')
  return (
    <Modal open={open} title="New group" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onSubmit(name.trim())
        }}
        className="space-y-4"
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Group name"
          className="input"
        />
        {error && <p className="text-sm text-warning">{error}</p>}
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="btn-primary w-full"
        >
          {pending ? 'Creating…' : 'Create group'}
        </button>
      </form>
    </Modal>
  )
}

function JoinModal({ open, onClose, onSubmit, pending, error }) {
  const [code, setCode] = useState('')
  return (
    <Modal open={open} title="Join a group" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (code.trim()) onSubmit(code.trim().toUpperCase())
        }}
        className="space-y-4"
      >
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Invite code"
          className="input text-center font-mono tracking-widest"
          maxLength={16}
        />
        {error && <p className="text-sm text-warning">{error}</p>}
        <button
          type="submit"
          disabled={pending || !code.trim()}
          className="btn-primary w-full"
        >
          {pending ? 'Joining…' : 'Join group'}
        </button>
      </form>
    </Modal>
  )
}

/* --- detail -------------------------------------------------------------- */
function GroupDetail({ groupId, onBack }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['group', groupId] })

  const { data: group, isPending } = useQuery({
    queryKey: ['group', groupId],
    queryFn: ({ signal }) => api.group(groupId, signal),
  })

  const share = useMutation({
    mutationFn: ({ domainId, body }) => api.updateShare(groupId, domainId, body),
    onSuccess: invalidate,
  })
  const viewQa = useMutation({
    mutationFn: ({ domainId, value }) => api.setViewQa(groupId, domainId, value),
    onSuccess: invalidate,
  })
  const leave = useMutation({
    mutationFn: () => api.leaveGroup(groupId, user?.id),
    onSuccess: onBack,
  })
  const destroy = useMutation({
    mutationFn: () => api.deleteGroup(groupId),
    onSuccess: onBack,
  })

  const [copied, setCopied] = useState(false)

  if (isPending) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-6 w-32" />
        <div className="skeleton h-40 rounded-2xl" />
      </div>
    )
  }
  if (!group) return null

  const shared = group.shared_domains || []

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <PageTitle
          onBack={onBack}
          backLabel="All groups"
          subtitle={`${group.member_count} member${
            group.member_count === 1 ? '' : 's'
          }${group.is_owner ? ' · you own this' : ''}`}
        >
          {group.name}
        </PageTitle>

        {group.invite_code && (
          <button
            onClick={() => {
              navigator.clipboard?.writeText(group.invite_code)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className="flex items-center gap-2 rounded-xl bg-surface2 px-3 py-2 text-sm"
          >
            <span className="font-mono tracking-widest text-accent2">
              {group.invite_code}
            </span>
            <Copy size={14} className="text-sec" aria-hidden="true" />
            <span className="text-xs text-sec">{copied ? 'Copied' : 'Invite code'}</span>
          </button>
        )}
      </div>

      {/* Members */}
      <section className="space-y-3">
        <SectionHeader>Members</SectionHeader>
        <div className="card space-y-2.5">
          {group.members.map((m) => (
            <div key={m.user_id} className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-surface2 text-xs font-medium text-sec">
                {(m.name || '?').slice(0, 1).toUpperCase()}
              </span>
              <span className="flex-1 text-sm text-pri">{m.name || 'Member'}</span>
              {m.role === 'owner' && <span className="chip-accent">Owner</span>}
            </div>
          ))}
        </div>
      </section>

      {/* Shared domains */}
      <section className="space-y-3">
        <SectionHeader>Shared domains</SectionHeader>
        {shared.length === 0 ? (
          <p className="card text-center text-sm text-sec">
            {group.is_owner
              ? 'Nothing shared yet. Share a domain from its module to let members study it.'
              : 'The owner hasn’t shared any domains yet.'}
          </p>
        ) : (
          <div className="space-y-3">
            {shared.map((d) => (
              <div key={d.domain_id} className="card space-y-3">
                <div>
                  <p className="text-sm font-medium text-pri">{d.title}</p>
                  {d.module_title && <p className="text-xs text-sec">{d.module_title}</p>}
                </div>

                {group.is_owner ? (
                  <div className="space-y-2.5 border-t border-border pt-3">
                    <ToggleRow
                      label="Share lecture"
                      checked={d.share_lecture}
                      onChange={(v) =>
                        share.mutate({
                          domainId: d.domain_id,
                          body: { share_lecture: v },
                        })
                      }
                    />
                    <ToggleRow
                      label="Share Q&A"
                      checked={d.share_qa}
                      onChange={(v) =>
                        share.mutate({ domainId: d.domain_id, body: { share_qa: v } })
                      }
                    />
                  </div>
                ) : (
                  <div className="space-y-2 border-t border-border pt-3">
                    <p className="text-xs text-sec">
                      {d.share_lecture ? 'Lecture shared' : 'Lecture not shared'}
                    </p>
                    {/* Invitee's own Q&A view toggle — only meaningful when the
                        owner has enabled Q&A sharing. */}
                    <ToggleRow
                      label="Show Q&A"
                      icon={MessageSquare}
                      checked={d.view_qa}
                      disabled={!d.share_qa}
                      hint={!d.share_qa ? 'Owner hasn’t shared Q&A' : undefined}
                      onChange={(v) => viewQa.mutate({ domainId: d.domain_id, value: v })}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Danger zone */}
      <div className="pt-2">
        {group.is_owner ? (
          <button onClick={() => destroy.mutate()} className="btn-ghost text-sm text-warning">
            Delete group
          </button>
        ) : (
          <button onClick={() => leave.mutate()} className="btn-ghost text-sm text-warning">
            Leave group
          </button>
        )}
      </div>
    </div>
  )
}

function ToggleRow({ label, icon: Icon, checked, onChange, disabled, hint }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {Icon && <Icon size={15} className="text-sec" aria-hidden="true" />}
        <span className="text-sm text-pri">{label}</span>
        {hint && <span className="text-xs text-sec">· {hint}</span>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  )
}
