-- ═══════════════════════════════════════════════════════════════════════════
-- 0099 — the page is part of the key in the TABLE too, not only in the code.
--
-- WHAT WAS WRONG, found by committing two real Clarity exports:
--
--     duplicate key value violates unique constraint
--     "scroll_runs_client_id_round_id_device_captured_from_capture_key"
--
-- LP1 for 0926-01 went in. LP2 — same round, same device, same window, a
-- DIFFERENT PAGE — was refused.
--
-- 0032 created the table with:
--
--     -- One curve per page per device per window.
--     unique (client_id, round_id, device, captured_from, captured_to)
--
-- The comment says "per page". The constraint has no page column in it. The
-- comment described the intention and the constraint never matched it, and
-- because Shely had only ever had one landing page per round, nothing had
-- asked the question until today.
--
-- The application half was already fixed. 0092 added scroll_runs.page_key, and
-- the importer's prior-run match takes six fields — client, round, device,
-- captured_from, captured_to and the page key — precisely so that LP2 arriving
-- over LP1 is a new measurement rather than a re-export. That fix is real and
-- it works; it was sitting on top of a table that still enforced five.
--
-- So the two halves disagreed, and the disagreement had two possible outcomes.
-- This one — a refusal — is by far the better of them: the older failure mode,
-- before the page joined the code's match, was that LP2 matched LP1 as a
-- re-export and DELETED it. Losing one of two measurements silently is worse
-- than being told no. The constraint was, accidentally, the thing that stopped
-- the bad outcome from recurring while the code was wrong.
--
-- ── WHY coalesce AND NOT A PLAIN UNIQUE ────────────────────────────────────
--
-- page_key is nullable, and legitimately so: an export that filtered on no URL
-- at all has no page, which is a real answer for a client running one page.
--
-- A plain `unique (..., page_key)` would treat NULLs as distinct from each
-- other, so two unfiltered exports of the same round, device and window would
-- both be allowed to sit there — and the re-export that should have REPLACED
-- its predecessor would double the traffic instead. That is the original fault
-- of this table arriving through a different door.
--
-- The index therefore keys on coalesce(page_key, ''), which makes "no page" a
-- value that equals itself. It matches the importer exactly, which says so in
-- its own words: "A null key has to match a null key rather than matching
-- everything."
--
-- `nulls not distinct` would also work on this Postgres, and is not used: the
-- coalesce form states the rule in the index itself rather than in a modifier
-- somebody has to know the semantics of, and it behaves the same on any version
-- this schema might be restored onto.
--
-- Nothing existing violates the new key — one run on 0526-03 with no page, one
-- on 0926-01 with a page — so this cannot fail on current data. If it does
-- fail, two curves are already stacked on one page and the conflicting pair is
-- named in the error; that is worth reading rather than forcing.
--
-- Safe to re-run.
--
-- ROLLBACK:
--   drop index if exists scroll_runs_one_curve_per_page;
--   alter table scroll_runs add constraint
--     scroll_runs_client_id_round_id_device_captured_from_capture_key
--     unique (client_id, round_id, device, captured_from, captured_to);
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- The five-field key, retired. Dropped by its generated name, which is what the
-- error message names, and IF EXISTS so a re-run is quiet.
alter table scroll_runs
  drop constraint if exists scroll_runs_client_id_round_id_device_captured_from_capture_key;

-- The six-field key the code has been applying since 0092.
create unique index if not exists scroll_runs_one_curve_per_page
  on scroll_runs (client_id, round_id, device, captured_from, captured_to, coalesce(page_key, ''));

comment on index scroll_runs_one_curve_per_page is
  'One curve per PAGE per device per window. The page is in the key: two landing '
  'pages measured over the same round, device and dates are two measurements, and '
  'coalesce makes "no page filter" a value that equals itself so a re-export of an '
  'unfiltered curve still replaces its predecessor rather than doubling it.';

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. The old constraint is gone and the new index is there:
--
--      select indexname from pg_indexes
--       where tablename = 'scroll_runs' and indexname = 'scroll_runs_one_curve_per_page';
--      select conname from pg_constraint
--       where conrelid = 'scroll_runs'::regclass and contype = 'u';
--
--    Expect one row from the first, and no five-field unique from the second.
--
-- 2. Two pages can now coexist on one round, device and window. This is the
--    case that was refused; it rolls itself back:
--
--      begin;
--      insert into scroll_runs (client_id, round_id, page_key, device, sessions, captured_from, captured_to)
--      select client_id, round_id, page_key || '-TEST', device, sessions, captured_from, captured_to
--        from scroll_runs where round_id = '0926-01' limit 1;
--      select count(*) from scroll_runs where round_id = '0926-01';   -- expect 2
--      rollback;
--
-- 3. And a re-export of the SAME page still collides, which is the half that
--    must keep working — replacing rather than doubling:
--
--      begin;
--      insert into scroll_runs (client_id, round_id, page_key, device, sessions, captured_from, captured_to)
--      select client_id, round_id, page_key, device, sessions, captured_from, captured_to
--        from scroll_runs where round_id = '0926-01' limit 1;
--      rollback;
--
--    Expect a duplicate-key error naming scroll_runs_one_curve_per_page. An
--    insert that SUCCEEDS here is the failure — it would mean one page can hold
--    two curves for one window, which reads as twice the traffic.
