-- ============================================================================
-- AI Study Tutor — group sharing controls (spec Prompt 8)
--
-- The base group tables let an owner share a domain into a group, but the spec
-- wants finer control: the owner toggles the lecture and the Q&A on or off per
-- shared domain, and each invitee has their own "show Q&A" toggle. Q&A is
-- visible to an invitee only when BOTH the owner's share_qa and the invitee's
-- view_qa are true.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- Owner-side toggles on each shared domain.
alter table public.group_shared_domains
  add column if not exists share_lecture boolean not null default true,
  add column if not exists share_qa      boolean not null default false;

-- Invitee-side view preference, one row per (group, domain, member). Defaults
-- to true so that when an owner enables Q&A the invitee sees it without extra
-- action, while still being able to hide it for themselves.
create table if not exists public.group_domain_views (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups (id) on delete cascade,
  domain_id  uuid not null references public.domains (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  view_qa    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, domain_id, user_id)
);
create index if not exists group_domain_views_lookup_idx
  on public.group_domain_views (group_id, user_id);

alter table public.group_domain_views enable row level security;

-- A member manages only their own view preferences.
drop policy if exists "group_domain_views: owner all" on public.group_domain_views;
create policy "group_domain_views: owner all" on public.group_domain_views
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
