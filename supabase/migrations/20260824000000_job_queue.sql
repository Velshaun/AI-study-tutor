-- ============================================================================
-- AI Study Tutor — a durable job queue
--
-- Every long-running thing in this app has so far been a FastAPI BackgroundTask:
-- in-process, unnamed, and gone the moment Railway redeploys. That was tolerable
-- for a 30-second generation the learner was watching. It is not tolerable for
-- importing a 200-video playlist, where the work outlives several deploys and
-- the learner is expected to close the tab.
--
-- Two tables, because a job and its items fail differently. A job is the thing
-- the learner asked for ("import this playlist"); an item is one unit of it
-- ("fetch this video's transcript"). Items carry their own status and their own
-- failure reason precisely so a batch never rolls back: what succeeded is kept,
-- what failed is re-queueable on its own, and the learner never re-pastes
-- anything.
--
-- `claim_job` and `claim_job_item` use FOR UPDATE SKIP LOCKED. Only one worker
-- runs today, so strictly this is unnecessary — it is written this way now
-- because the alternative is discovering under load that turning on a second
-- worker means rewriting the claim path. SKIP LOCKED is also why the claim has
-- to be a database function at all: the backend speaks to Postgres through
-- PostgREST, which has no way to express row locking.
--
-- Interruption is handled by reclaiming rather than restarting. A job whose
-- worker stopped heartbeating is picked up again, and only its unfinished items
-- are re-run — an interrupted playlist continues from the next video rather
-- than fetching the first hundred a second time.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.jobs (
  id              uuid primary key default gen_random_uuid(),
  module_id       uuid references public.modules (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  -- 'import_youtube' | 'import_paste' | 'import_url' | ...
  kind            text not null,
  status          text not null default 'queued'
                    check (status in ('queued', 'running', 'succeeded',
                                      'failed', 'cancelled')),
  -- What the learner asked for, so a reclaimed job can rebuild its own context.
  payload         jsonb not null default '{}'::jsonb,
  total_items     integer not null default 0,
  completed_items integer not null default 0,
  failed_items    integer not null default 0,
  error           text,
  -- Which worker holds it, and when it last said so. A claim with a stale
  -- heartbeat is up for grabs; see `claim_job`.
  claimed_by      text,
  claimed_at      timestamptz,
  heartbeat_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create table if not exists public.job_items (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.jobs (id) on delete cascade,
  -- A playlist is one parent item with one child per video. The parent is kept
  -- even when every child fails: the children hold the failure reasons that
  -- drive Retry Failed, so removing the parent would destroy the ability to
  -- retry at all.
  parent_item_id uuid references public.job_items (id) on delete cascade,
  position       integer not null default 0,
  kind           text not null default 'item',
  status         text not null default 'pending'
                   check (status in ('pending', 'running', 'succeeded',
                                     'failed', 'skipped')),
  -- The unit of work: a video id, a pasted blob, a URL.
  payload        jsonb not null default '{}'::jsonb,
  -- Where it got to, so an interrupted item resumes rather than restarts.
  checkpoint     jsonb not null default '{}'::jsonb,
  result         jsonb not null default '{}'::jsonb,
  error          text,
  -- 'permanent' (no transcript exists — retrying will never help) or
  -- 'transient' (a timeout, a rate limit). Only transient failures are
  -- auto-retried; permanent ones wait for the learner to decide.
  failure_kind   text check (failure_kind in ('permanent', 'transient')),
  attempts       integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists jobs_claimable_idx
  on public.jobs (status, created_at);
create index if not exists jobs_user_idx on public.jobs (user_id, created_at desc);
create index if not exists jobs_module_idx on public.jobs (module_id);
create index if not exists job_items_job_idx on public.job_items (job_id, position);
create index if not exists job_items_claimable_idx on public.job_items (job_id, status);
create index if not exists job_items_parent_idx on public.job_items (parent_item_id);


-- --- claiming ---------------------------------------------------------------
-- Take the oldest queued job, or reclaim one whose worker has stopped saying it
-- is alive. SKIP LOCKED means a second worker takes the next row rather than
-- blocking on this one.
create or replace function public.claim_job(
  p_worker text,
  p_stale_after interval default '00:05:00'
)
returns setof public.jobs
language plpgsql
as $$
begin
  return query
  update public.jobs j
     set status       = 'running',
         claimed_by   = p_worker,
         claimed_at   = now(),
         heartbeat_at = now(),
         updated_at   = now()
   where j.id = (
     select c.id
       from public.jobs c
      where c.status = 'queued'
         or (c.status = 'running'
             and coalesce(c.heartbeat_at, c.claimed_at, c.created_at)
                 < now() - p_stale_after)
      order by c.created_at
      for update skip locked
      limit 1
   )
  returning j.*;
end;
$$;

-- The same trick one level down, so items within a job can be handed out to
-- several concurrent fetches without two of them taking the same video.
create or replace function public.claim_job_item(p_job_id uuid)
returns setof public.job_items
language plpgsql
as $$
begin
  return query
  update public.job_items i
     set status     = 'running',
         attempts   = i.attempts + 1,
         updated_at = now()
   where i.id = (
     select c.id
       from public.job_items c
      where c.job_id = p_job_id
        and c.status = 'pending'
      order by c.position
      for update skip locked
      limit 1
   )
  returning i.*;
end;
$$;


-- --- row-level security ------------------------------------------------------
alter table public.jobs enable row level security;
alter table public.job_items enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'jobs'
      and policyname = 'jobs: owner all'
  ) then
    create policy "jobs: owner all" on public.jobs
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;

  -- Items are reached through their job, so ownership is the job's ownership.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'job_items'
      and policyname = 'job_items: owner all'
  ) then
    create policy "job_items: owner all" on public.job_items
      for all using (
        exists (select 1 from public.jobs j
                 where j.id = job_items.job_id and j.user_id = auth.uid())
      ) with check (
        exists (select 1 from public.jobs j
                 where j.id = job_items.job_id and j.user_id = auth.uid())
      );
  end if;
end
$$;


-- --- realtime ----------------------------------------------------------------
-- The browser subscribes with the learner's own JWT, so RLS above is what stops
-- one account watching another's imports. The worker writes with the service
-- role, which bypasses RLS — that asymmetry is deliberate and is why the policy
-- is written for the reader rather than the writer.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'jobs'
  ) then
    alter publication supabase_realtime add table public.jobs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'job_items'
  ) then
    alter publication supabase_realtime add table public.job_items;
  end if;
end
$$;
