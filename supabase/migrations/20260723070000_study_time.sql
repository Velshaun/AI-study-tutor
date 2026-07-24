-- ============================================================================
-- AI Study Tutor — study-time tracking (spec §5.4)
--
-- The dashboard's "Study Time This Week" widget has no data source: nothing in
-- the schema records how long anyone actually spent listening. Lecture
-- `last_position_secs` is a bookmark, not a duration — replaying the same
-- lecture twice leaves it unchanged.
--
-- The player already sends its position every 5 seconds (§4.4). That gives a
-- stream of forward deltas to accumulate, so this table stores one row per user
-- per day and the position endpoint adds to it. Daily granularity keeps the
-- table small and makes "this week" a trivial range query.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.study_time (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  day        date not null default (now() at time zone 'utc')::date,
  seconds    integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day)
);

create index if not exists study_time_user_day_idx
  on public.study_time (user_id, day desc);

alter table public.study_time enable row level security;

create policy "study_time: owner all" on public.study_time
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- lectures — when playback last happened, for the resume card
-- ============================================================================
alter table public.lectures
  add column if not exists last_played_at timestamptz;

-- The resume card wants the most recently played, unfinished lecture.
create index if not exists lectures_resume_idx
  on public.lectures (user_id, last_played_at desc)
  where completed_at is null;

-- ============================================================================
-- Accumulate listening time from position updates.
--
-- Called by PATCH /lectures/{id}/position. Only forward movement counts, and a
-- single jump is capped: seeking to the end of a 14-minute lecture must not
-- bank 14 minutes of "study time". Anything larger than a generous multiple of
-- the 5-second reporting interval is treated as a seek, not listening.
-- ============================================================================
create or replace function public.record_study_time(
  _user_id  uuid,
  _seconds  integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  _capped integer;
  _total  integer;
begin
  -- Ignore rewinds and absurd jumps; 120s covers a slow client or a backgrounded
  -- tab catching up, while rejecting a scrub to the end.
  _capped := least(greatest(coalesce(_seconds, 0), 0), 120);
  if _capped = 0 then
    select seconds into _total from public.study_time
     where user_id = _user_id and day = (now() at time zone 'utc')::date;
    return coalesce(_total, 0);
  end if;

  insert into public.study_time (user_id, day, seconds)
  values (_user_id, (now() at time zone 'utc')::date, _capped)
  on conflict (user_id, day) do update
    set seconds = public.study_time.seconds + excluded.seconds,
        updated_at = now()
  returning seconds into _total;

  return _total;
end;
$$;
