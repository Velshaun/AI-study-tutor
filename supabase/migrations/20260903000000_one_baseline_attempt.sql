-- A module's baseline is sat once, and the database is where that is true.
--
-- `practice_exams_one_pre_assessment_idx` already makes sure a module has only
-- one pre-assessment *exam*, and it has always held. Nothing guarded the
-- *attempt*: re-entering the paper and handing it in again wrote a second row
-- against the same exam, with the same answers and the same score. The baseline
-- is the line every later sitting is measured against, so two of them is two
-- different lines — and which one wins depends on how a query happens to sort.
--
-- Practice attempts are deliberately not covered: sitting a practice paper
-- again is the whole point of one.
--
-- NOTE: this fails while a duplicate exists. Resolve the duplicates first.

create unique index if not exists exam_attempts_one_baseline_idx
  on public.exam_attempts (exam_id)
  where kind = 'pre_assessment';
