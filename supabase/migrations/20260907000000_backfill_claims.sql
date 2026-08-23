-- Generating a domain's practice set is claimed in the database, not in memory.
--
-- `practice_mode` guarded concurrent generation with a Python `set` and a
-- `threading.Lock`. That holds for exactly one process: the moment the API runs
-- a second uvicorn worker or a second Railway replica, two requests for the
-- same domain both see a free slot and both generate — duplicate questions and
-- two Gemini bills for one set. Nothing announces that day; it simply arrives.
--
-- Same shape as `claim_job`, one level smaller. `on conflict do nothing` is the
-- whole of the mutual exclusion: exactly one inserter wins a primary key, and
-- Postgres decides which, so there is no window between checking and taking.
-- A claim whose process died is taken over once it goes stale, because the
-- alternative is a domain that can never be generated again.
--
-- Idempotent and safe to re-run.

create table if not exists public.backfill_claims (
  domain_id  uuid primary key references public.domains (id) on delete cascade,
  worker     text not null,
  claimed_at timestamptz not null default now()
);

alter table public.backfill_claims enable row level security;
-- No policy: only the service role touches this, and it bypasses RLS. RLS on
-- with no policy is the safe default — a leaked anon key reads nothing.

create or replace function public.claim_backfill(
  p_domain_id uuid,
  p_worker text,
  p_stale_after interval default '00:10:00'
)
returns boolean
language plpgsql
as $$
declare
  v_claimed boolean := false;
begin
  -- Take it if it is free.
  insert into public.backfill_claims (domain_id, worker)
       values (p_domain_id, p_worker)
  on conflict (domain_id) do nothing;

  if found then
    return true;
  end if;

  -- Held. Take it over only if whoever held it has plainly stopped: a
  -- generation runs in a request's background task, so a claim older than the
  -- longest plausible run belongs to a process that is gone.
  update public.backfill_claims
     set worker = p_worker, claimed_at = now()
   where domain_id = p_domain_id
     and claimed_at < now() - p_stale_after
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

create or replace function public.release_backfill(p_domain_id uuid)
returns void
language sql
as $$
  delete from public.backfill_claims where domain_id = p_domain_id;
$$;
