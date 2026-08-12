-- ═══════════════════════════════════════════════════════════════════════════
-- Funnel OS — patch 0005: the import pipeline
--
-- The workflow the brief specifies is gated and one-way:
--
--   imported ──→ matched ──→ attributed ──→ diffed ──→ committed
--                    │
--                    ├──→ auto-resolved  (confident match, counted, no review)
--                    └──→ parked         (unmatched_rows, not counted, revenue held)
--
-- "Show the diff before committing" means a batch has to exist in a staged state
-- with its parsed rows attached, so nothing is written to events / ads_performance
-- until someone approves it. That's what staged_payload and status are for.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

alter table import_batches
  add column if not exists status         text not null default 'committed'
    check (status in ('staged', 'committed', 'discarded')),
  add column if not exists file_name      text,
  add column if not exists staged_payload jsonb,   -- parsed rows, dropped on commit
  add column if not exists diff_summary   jsonb,   -- what the commit did / would do
  add column if not exists committed_at   timestamptz;

-- Everything seeded before this patch is already committed history.
update import_batches set status = 'committed' where status is null;

-- Which contact an unmatched row was finally tied to, when a human accepts the
-- best guess. Keeps the audit trail: the parked row is resolved, never deleted.
alter table unmatched_rows
  add column if not exists resolved_contact_id uuid references contacts (contact_id),
  add column if not exists resolved_by         text;

create index if not exists idx_import_batches_status on import_batches (status);
create index if not exists idx_unmatched_open
  on unmatched_rows (client_id) where resolved_at is null and auto_resolved = false;

-- The column mapping remembered per source: the most recent committed batch's map
-- is what the next import is checked against, so a renamed column breaks loudly
-- instead of importing a blank.
create or replace view v_column_map as
select distinct on (client_id, source)
  client_id, source, column_map, imported_at
from import_batches
where status = 'committed' and column_map is not null
order by client_id, source, imported_at desc;

-- Batches waiting for approval, for the Import screen.
create or replace view v_staged_batches as
select batch_id, client_id, source, file_name, row_count, imported_at,
       column_map, diff_summary
from import_batches
where status = 'staged'
order by imported_at desc;

grant select on v_column_map, v_staged_batches to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
