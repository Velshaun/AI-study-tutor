-- ============================================================================
-- AI Study Tutor — exam attempts, per domain, over time
--
-- Sitting a practice exam produced a percentage and then forgot it. The grade
-- was computed in the request, returned to the screen, and discarded: nothing
-- recorded that the attempt happened, and nothing recorded which domains the
-- questions had come from. So "you got 71%" was the most the app could ever
-- say, and it could not say it twice.
--
-- Two things change here.
--
-- `exam_attempts` keeps every sitting: the score, the pass mark it was judged
-- against, and — the point of the exercise — a per-domain breakdown of what was
-- right and wrong, alongside the weight each domain carries on the real paper.
-- Missing five of seven in a domain worth 32% is a different morning's work
-- from missing five of seven in one worth 4%, and until now the app could not
-- tell the two apart.
--
-- `kind` marks the first sitting as a pre-assessment. It is the same exam in
-- the same runner against the same weights; what makes it a baseline is only
-- that it came before the studying, so it is a flag rather than a second code
-- path pretending to be one.
--
-- The rolling performance model deliberately gets no table. It is derived from
-- these attempts on read — see `services/performance.py` — because a stored
-- score is a second copy of the truth that drifts from the attempts it came
-- from, and changing how strength is judged should not mean rewriting history.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- Which sitting this was. 'pre_assessment' is the baseline taken before study.
alter table public.practice_exams
  add column if not exists kind text not null default 'practice';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'practice_exams_kind_check'
  ) then
    alter table public.practice_exams
      add constraint practice_exams_kind_check
      check (kind in ('practice', 'pre_assessment'));
  end if;
end
$$;

create table if not exists public.exam_attempts (
  id            uuid primary key default gen_random_uuid(),
  exam_id       uuid not null references public.practice_exams (id) on delete cascade,
  module_id     uuid references public.modules (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  kind          text not null default 'practice'
                  check (kind in ('practice', 'pre_assessment')),
  score         numeric(5,2) not null default 0,
  correct       integer not null default 0,
  total         integer not null default 0,
  -- The threshold this attempt was judged against, stored with the attempt: a
  -- pass mark that changes later must not silently re-grade an old sitting.
  pass_pct      numeric(5,2),
  passed        boolean,
  -- [{domain_id, title, weight_pct, correct, total, pct}] — one per domain the
  -- paper actually asked about.
  domain_results jsonb not null default '[]'::jsonb,
  -- The written read on the attempt: strengths, gaps, what to do next.
  summary       jsonb not null default '{}'::jsonb,
  submitted_at  timestamptz not null default now()
);

create index if not exists exam_attempts_module_idx
  on public.exam_attempts (module_id, submitted_at);
create index if not exists exam_attempts_user_idx
  on public.exam_attempts (user_id, submitted_at);
create index if not exists exam_attempts_exam_idx
  on public.exam_attempts (exam_id);

alter table public.exam_attempts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'exam_attempts'
      and policyname = 'exam_attempts: owner all'
  ) then
    create policy "exam_attempts: owner all" on public.exam_attempts
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end
$$;
