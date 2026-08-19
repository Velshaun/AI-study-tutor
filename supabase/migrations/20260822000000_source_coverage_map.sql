-- ============================================================================
-- AI Study Tutor — the per-module source coverage map
--
-- The tutor's assessment used to read a 60,000-character sample of the uploaded
-- material: 6,000 characters from each source, then a hard stop. For a module
-- built from a page of notes that is the whole pack. For one built from a
-- textbook it is the first few pages, and everything after them was invisible.
-- A domain covered thoroughly in chapter nine read as "missing", and a learner
-- was told to go and find material they had already uploaded.
--
-- The fix is to read all of it, once, and keep what was learnt. Every source is
-- split into overlapping chunks, each chunk is assessed against the exam
-- blueprint on its own, and the per-chunk findings are aggregated into one map:
-- for each domain, how well it is covered, how deeply, and which files it came
-- from. The tutor then answers from the map instead of from the raw text, so an
-- assessment is a single cheap call however large the pack is.
--
-- One row per module, because the map is always written and read whole and is
-- recomputed atomically. `fingerprint` is what makes it cacheable: it hashes
-- the sources and the blueprint, so adding, removing or re-parsing anything
-- makes the stored map visibly stale without needing a cache-invalidation
-- message to arrive from somewhere else.
--
-- `truncated` exists because a cap that hides itself is worse than no cap. A
-- pack too large even for chunked reading records how much was read, and the
-- assessment says so rather than quietly implying it saw everything.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.coverage_maps (
  id             uuid primary key default gen_random_uuid(),
  module_id      uuid not null unique
                   references public.modules (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  status         text not null default 'computing'
                   check (status in ('computing', 'ready', 'failed')),
  -- Hash of the sources and the blueprint the map was built from. A mismatch
  -- means stale, and stale means recompute.
  fingerprint    text not null default '',
  -- One entry per exam domain: title, coverage, depth, topics, source files.
  domains        jsonb not null default '[]'::jsonb,
  chunk_count    integer not null default 0,
  chars_analysed bigint not null default 0,
  source_count   integer not null default 0,
  -- True when the pack exceeded even the chunked reader's ceiling.
  truncated      boolean not null default false,
  error          text,
  computed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists coverage_maps_user_idx
  on public.coverage_maps (user_id);

alter table public.coverage_maps enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'coverage_maps'
      and policyname = 'coverage_maps: owner all'
  ) then
    create policy "coverage_maps: owner all" on public.coverage_maps
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end
$$;
