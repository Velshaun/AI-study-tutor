-- A workbook: material studied as itself, with no blueprint imposed on it.
--
-- A module is a certification — sources go in, a Gemini pass derives weighted
-- domains, and everything downstream is measured against that blueprint. A
-- workbook skips the derivation entirely: one hidden domain holds all of its
-- material, generation draws only on what was actually uploaded, and the
-- missed-questions machinery works identically because it was module-scoped
-- all along. Same tables, one flag — the alternative was a parallel schema
-- with a permanent promise that two copies of every behaviour stay identical.
--
-- Idempotent and safe to re-run.

alter table public.modules
  add column if not exists kind text not null default 'module';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'modules_kind_check'
  ) then
    alter table public.modules
      add constraint modules_kind_check check (kind in ('module', 'workbook'));
  end if;
end
$$;
