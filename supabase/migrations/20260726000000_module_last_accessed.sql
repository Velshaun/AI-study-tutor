-- ============================================================================
-- Module "last accessed" — powers the dashboard "Last visited" section.
--
-- A dedicated table rather than a column on `modules`: updating any `modules`
-- row fires its `set_updated_at` trigger, which would reshuffle the dashboard
-- list (ordered by updated_at) every time a module is merely opened. Recording
-- access here keeps that list order untouched.
--
-- Idempotent.
-- ============================================================================
alter table public.modules drop column if exists last_accessed_at;

create table if not exists public.module_access (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  module_id   uuid not null references public.modules (id) on delete cascade,
  accessed_at timestamptz not null default now(),
  primary key (user_id, module_id)
);
create index if not exists module_access_user_idx on public.module_access (user_id);
