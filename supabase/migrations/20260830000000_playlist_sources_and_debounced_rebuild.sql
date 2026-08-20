-- ============================================================================
-- Playlists as one thing in the sources list, and rebuilds that wait.
--
-- Two problems, both created by imports being able to land ninety-seven rows at
-- once.
--
-- **A playlist is one source to a learner.** The queue is right to model it as a
-- listing plus a sibling per video — that is what claiming needs — but the
-- Sources tab showed the result literally, so importing one playlist buried
-- every uploaded PDF under ninety-seven video rows. `import_batch_id` already
-- identifies one import; `group_title` is the missing half, the name to put on
-- the pill. It is set only for children of a playlist, so its presence *is* the
-- signal that a batch should be drawn grouped rather than flat.
--
-- **Deleting sources changes what the study plan is derived from**, so the plan
-- has to be rebuilt — but deleting four videos should cost one rebuild, not
-- four. `rebuild_after` is a deadline rather than a queued job: every deletion
-- pushes it out, and the worker rebuilds whatever is due. Debounce falls out of
-- that for free, it survives a redeploy, and there is nothing to cancel when
-- the learner keeps deleting.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.user_files
  -- The playlist this source came from, as the learner would name it. Null for
  -- everything that isn't a playlist video.
  add column if not exists group_title text;

comment on column public.user_files.group_title is
  'Playlist name, for sources imported as part of one. Grouped with '
  'import_batch_id; null means show this source on its own.';

create index if not exists user_files_group_idx
  on public.user_files (module_id, import_batch_id)
  where group_title is not null;

alter table public.modules
  -- When this module's study plan is next due to be rebuilt, or null for "not
  -- due". Set to now() + a debounce window by anything that changes the
  -- material; cleared once the rebuild runs.
  add column if not exists rebuild_after timestamptz;

comment on column public.modules.rebuild_after is
  'Deadline for a pending study-plan rebuild. Each change pushes it out, so a '
  'run of deletions costs one rebuild rather than one each.';

-- The worker scans for due rebuilds on every poll, so this wants to be cheap
-- and to ignore the overwhelming majority of modules, which are not due.
create index if not exists modules_rebuild_due_idx
  on public.modules (rebuild_after)
  where rebuild_after is not null;
