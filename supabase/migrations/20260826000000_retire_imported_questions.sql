-- ============================================================================
-- AI Study Tutor — retire the second question table, and stop counting the
-- slow way
--
-- Two unrelated things, in one migration because both are small and applying
-- DDL here needs a personal access token that shouldn't be fetched twice.
--
-- --- 1. One question table ---------------------------------------------------
--
-- Importing an exam PDF already writes a real `practice_exams` row and real
-- `practice_questions` — that was the point of it, so an imported paper behaves
-- like a generated one by construction rather than by keeping two code paths in
-- agreement. `imported_practice_questions` was then written *as well*, a second
-- copy of the same questions, serving three readers: the imported-sets card,
-- the "mix real past-paper questions into a generated exam" toggle, and the
-- exam-length fallback.
--
-- So the duplicate goes. What it held that the exam row didn't — the source
-- file's name, a favourite flag, which import produced it — moves onto
-- `practice_exams`, where it belongs: an imported paper is an exam, and those
-- are properties of the paper.
--
-- The backup is taken unconditionally and the backfill is written to be correct
-- wherever it runs. On this database both moved zero rows, because the table
-- was already empty — but a migration is the artifact, and it has to be right
-- somewhere it isn't.
--
-- --- 2. Counting a job's progress -------------------------------------------
--
-- `jobs.completed_items` is derived from `job_items` on every change rather
-- than incremented, because a counter nudged per item drifts the moment
-- anything is retried and this is the number the learner watches. Deriving it
-- from Python cost two round trips — select every item, then update the job —
-- measured at 278ms of the 366ms each item spent on bookkeeping. As one
-- statement it is a single round trip and the accuracy is unchanged.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- --- 1a. Back up, then move -------------------------------------------------
do $$
begin
  if to_regclass('public.imported_practice_questions') is not null
     and to_regclass('public.imported_practice_questions_backup') is null then
    create table public.imported_practice_questions_backup as
      select * from public.imported_practice_questions;
  end if;
end
$$;

alter table public.practice_exams
  -- 'generated' | 'imported_pdf'. Matches practice_questions.origin.
  add column if not exists origin          text not null default 'generated',
  add column if not exists import_batch_id uuid,
  -- The uploaded file this paper came out of, for the imported-sets list.
  add column if not exists source_name     text,
  add column if not exists is_favourite    boolean not null default false;

create index if not exists practice_exams_origin_idx
  on public.practice_exams (origin);
create index if not exists practice_exams_batch_idx
  on public.practice_exams (import_batch_id);

-- Mark the papers that came from a PDF. An imported exam is recognisable by
-- having questions whose origin says so — the exam row itself predates the
-- column, so it is inferred rather than assumed.
update public.practice_exams e
   set origin = 'imported_pdf'
 where e.origin = 'generated'
   and exists (
     select 1 from public.practice_questions q
      where q.exam_id = e.id and q.origin = 'imported_pdf'
   );

-- Carry the batch id and source name across from the questions that hold them.
update public.practice_exams e
   set import_batch_id = coalesce(e.import_batch_id, sub.batch)
  from (
    -- No min() for uuid, so take the first of an ordered aggregate.
    select exam_id, (array_agg(import_batch_id order by import_batch_id))[1] as batch
      from public.practice_questions
     where import_batch_id is not null
     group by exam_id
  ) sub
 where sub.exam_id = e.id and e.import_batch_id is null;

-- The old table is kept, empty and unread, until the next migration drops it.
-- Dropping it in the same change that stops writing to it would leave no way
-- back if a reader was missed.


-- --- 2. One-statement job recount -------------------------------------------
create or replace function public.recount_job(p_job_id uuid)
returns setof public.jobs
language sql
as $$
  update public.jobs j
     set total_items     = c.total,
         completed_items = c.done,
         failed_items    = c.failed,
         updated_at      = now()
    from (
      select count(*)                                          as total,
             count(*) filter (where status = 'succeeded')       as done,
             count(*) filter (where status = 'failed')          as failed
        from public.job_items
       where job_id = p_job_id
    ) c
   where j.id = p_job_id
  returning j.*;
$$;
