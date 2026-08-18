-- ============================================================================
-- AI Study Tutor — learner-reported dead links
--
-- The Chat tab's source discovery validates every link before showing it
-- (app/services/link_check.py), but a static blocklist can't know that a page
-- died yesterday or that a host started walling its content. A learner who
-- hits a broken result can now say so, and that report is honoured on their
-- future searches:
--
--   * the reported URL is dropped outright,
--   * a host the learner has reported several distinct URLs on is dropped
--     wholesale (see link_check.HOST_STRIKES).
--
-- Reports are per-learner. Nothing here is shared between accounts: one
-- person's "this is walled for me" is not evidence for everyone, and keeping
-- it local avoids one account being able to poison another's results.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.dead_link_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  -- The URL exactly as it was shown to the learner.
  url        text not null,
  -- Registrable host, denormalised so the host-strike query stays an index scan.
  host       text not null default '',
  -- 'dead' | 'paywalled' | 'irrelevant' — free text, so the UI can grow.
  reason     text not null default 'dead',
  created_at timestamptz not null default now(),
  unique (user_id, url)
);

create index if not exists dead_link_reports_user_id_idx
  on public.dead_link_reports (user_id);
create index if not exists dead_link_reports_user_host_idx
  on public.dead_link_reports (user_id, host);

alter table public.dead_link_reports enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'dead_link_reports'
      and policyname = 'dead_link_reports: owner all'
  ) then
    create policy "dead_link_reports: owner all" on public.dead_link_reports
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end
$$;
