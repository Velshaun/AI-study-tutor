-- ============================================================================
-- AI Study Tutor — filing a source under a domain
--
-- Sources have been module-scoped since the beginning: a module holds a pile of
-- material, and the blueprint is derived from all of it at once. That works for
-- five uploads. It does not work for a two-hundred-video playlist, where the
-- question stops being "what does this module cover" and becomes "which of
-- these forty videos is about subnetting".
--
-- So a source gets a domain. Exactly one — the primary — because a video is
-- filed where it mostly belongs, and spreading one transcript across four
-- domains overstates coverage in all four.
--
-- `domain_confidence` is recorded and never shown. Where the match is weak the
-- model still picks the best fit and the number goes here, so a later rebuild
-- can revisit the shaky ones. Asking the learner where a video belongs is not
-- an option: a wrong assignment is a small cost, and making someone file their
-- own material is the thing this feature exists to avoid.
--
-- ON DELETE SET NULL, deliberately. Sources outlive the blueprint: re-running
-- ingestion redraws the domains, and a transcript whose domain went away is
-- still perfectly good material. Cascading here would delete the learner's
-- sources every time the study plan changed, which is the exact failure the
-- ingestion guard exists to prevent one level up.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.user_files
  add column if not exists domain_id uuid
    references public.domains (id) on delete set null,
  -- 0.0 to 1.0. Internal: drives a later re-assignment pass, never surfaced.
  add column if not exists domain_confidence real,
  -- Which import produced this source, so one bad playlist is one delete.
  add column if not exists import_batch_id uuid,
  -- The parent source a child belongs to: a playlist row owns its videos.
  add column if not exists parent_source_id uuid
    references public.user_files (id) on delete cascade;

create index if not exists user_files_domain_idx on public.user_files (domain_id);
create index if not exists user_files_batch_idx on public.user_files (import_batch_id);
create index if not exists user_files_parent_idx on public.user_files (parent_source_id);
