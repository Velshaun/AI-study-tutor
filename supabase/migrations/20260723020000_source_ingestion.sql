-- ============================================================================
-- AI Study Tutor — source upload & AI processing pipeline (spec §4.3)
--
-- §4.3 step 1 stores uploads in `user_files`, and step 2 parses them to text
-- that steps 3-6 feed to Gemini. The pipeline runs in the background, so the
-- parsed text and per-source progress have to be persisted rather than held in
-- request memory.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ============================================================================
-- user_files — parsed content + per-source pipeline state
-- ============================================================================
alter table public.user_files
  -- 'pdf' | 'youtube' | 'web' | 'audio' | 'text'
  add column if not exists source_type     text not null default 'pdf',
  -- populated for youtube/web sources, which have no uploaded bytes
  add column if not exists source_url      text,
  -- step 2 output, consumed by steps 3-6
  add column if not exists extracted_text  text,
  add column if not exists char_count      integer not null default 0,
  -- 'pending' | 'parsing' | 'parsed' | 'failed'
  add column if not exists status          text not null default 'pending',
  add column if not exists error_message   text,
  add column if not exists parsed_at       timestamptz;

create index if not exists user_files_module_id_idx on public.user_files (module_id);
create index if not exists user_files_status_idx    on public.user_files (status);

-- storage_path is empty for link-based sources (YouTube / web), which never
-- touch Storage.
alter table public.user_files alter column storage_path drop not null;
alter table public.user_files alter column storage_path set default '';

-- ============================================================================
-- modules — pipeline progress + provenance for the extracted domain map
-- ============================================================================
alter table public.modules
  -- 'processing' | 'parsing' | 'analysing' | 'ready' | 'failed' (step 8)
  add column if not exists status_detail    text,
  add column if not exists error_message    text,
  -- what Gemini decided the material actually is (step 4)
  add column if not exists detected_subject text,
  add column if not exists subject_confidence numeric,
  -- grounding citations backing the weightings (step 5)
  add column if not exists weighting_sources jsonb not null default '[]'::jsonb,
  add column if not exists processed_at     timestamptz;

create index if not exists modules_status_idx on public.modules (status);

-- ============================================================================
-- domains — mark rows the AI derived vs. ones the user authored
-- ============================================================================
alter table public.domains
  add column if not exists source text not null default 'ai';

-- The pipeline replaces a module's AI-derived domains on re-run, so it needs a
-- stable key to upsert against rather than duplicating rows.
create unique index if not exists domains_module_order_unique
  on public.domains (module_id, order_index)
  where order_index is not null;

-- ============================================================================
-- Storage bucket for uploaded sources (private; served via signed URLs)
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('sources', 'sources', false, 52428800)
on conflict (id) do nothing;

-- Users may only touch objects under their own uid/ prefix. The backend uses
-- the service-role key and bypasses these, but they matter if the frontend
-- ever uploads directly.
drop policy if exists "sources: read own"   on storage.objects;
drop policy if exists "sources: insert own" on storage.objects;
drop policy if exists "sources: delete own" on storage.objects;

create policy "sources: read own" on storage.objects
  for select using (
    bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "sources: insert own" on storage.objects
  for insert with check (
    bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "sources: delete own" on storage.objects
  for delete using (
    bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text
  );
