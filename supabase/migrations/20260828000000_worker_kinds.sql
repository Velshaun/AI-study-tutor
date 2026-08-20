-- ============================================================================
-- Let a worker claim only the kinds of work it can actually do.
--
-- YouTube refuses transcript requests from datacentre IPs, and a Railway worker
-- is exactly that: measured on 20 Aug 2026, 0 of 21 videos succeeded from the
-- worker and 4 of 4 from a laptop in the same minute. So transcripts are
-- fetched from a residential machine while everything else stays on Railway —
-- two workers, one queue.
--
-- The split has to happen inside the claim rather than in the loop. A worker
-- that claims a job it has no handler for does not skip it: it fails the job
-- outright, by design, because an unknown kind is normally a deploy problem
-- rather than a data problem. So "not my kind" must mean "never claimed".
--
-- `p_kinds` null keeps the old behaviour of claiming anything, so a deployment
-- that hasn't set WORKER_KINDS yet behaves exactly as it did before.
--
-- The two-argument form is dropped rather than left beside this one. Postgres
-- would keep both as overloads, and PostgREST cannot then resolve which of the
-- two a request means.
--
-- Idempotent: safe to re-run.
-- ============================================================================

drop function if exists public.claim_job(text, interval);

create or replace function public.claim_job(
  p_worker text,
  p_stale_after interval default '00:05:00',
  p_kinds text[] default null
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
      where (p_kinds is null or c.kind = any (p_kinds))
        and (c.status = 'queued'
             or (c.status = 'running'
                 and coalesce(c.heartbeat_at, c.claimed_at, c.created_at)
                     < now() - p_stale_after))
      order by c.created_at
      for update skip locked
      limit 1
   )
  returning j.*;
end;
$$;

-- Claiming is the queue's only contended operation, and it now filters on kind
-- as well as status. Without this the filter is a sequential scan of every job
-- ever run, taken while holding a row lock.
create index if not exists jobs_claimable_kind_idx
  on public.jobs (kind, status, created_at);
