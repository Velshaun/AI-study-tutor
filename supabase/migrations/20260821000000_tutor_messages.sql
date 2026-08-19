-- ============================================================================
-- AI Study Tutor — the module tutor's conversation
--
-- The Chat tab could find web resources but had no memory: its messages lived
-- in React state, so switching tab threw the conversation away. It also had no
-- idea what the learner had actually uploaded, which is the one thing a tutor
-- attached to a module should know — "is what I've given you enough to pass?"
-- was unanswerable.
--
-- One row per message, per module. `kind` records what the tutor did:
--
--   question   -> answered from the module's own material
--   assessment -> judged how well the sources cover the exam blueprint
--   resources  -> searched the web for free study material
--
-- `payload` carries the structured part of an answer — per-domain coverage for
-- an assessment, the validated links for a resource search — so the tab can
-- re-render a past answer exactly as it first appeared rather than as plain
-- text.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.tutor_messages (
  id         uuid primary key default gen_random_uuid(),
  module_id  uuid not null references public.modules (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null default '',
  kind       text not null default 'question'
               check (kind in ('question', 'assessment', 'resources')),
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tutor_messages_module_idx
  on public.tutor_messages (module_id, created_at);
create index if not exists tutor_messages_user_idx
  on public.tutor_messages (user_id);

alter table public.tutor_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tutor_messages'
      and policyname = 'tutor_messages: owner all'
  ) then
    create policy "tutor_messages: owner all" on public.tutor_messages
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end
$$;
