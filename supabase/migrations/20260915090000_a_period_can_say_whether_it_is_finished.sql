-- A period can say whether it is finished.
--
-- WHY THIS EXISTS. AcqOS wants to know which months it may report on. GroundTruth
-- has never had an answer, because it has never had the concept: there is no
-- `finalised` flag, no `closed_at`, no period_status column anywhere in the
-- schema. Searched for all four on 15 September 2026 and found nothing.
--
-- That is not an oversight to be patched with a boolean. A flag somebody sets by
-- hand is a claim about the data that the data cannot contradict — it says
-- "August is done" and stays saying it after a late export lands. The honest
-- version is DERIVED, so it cannot disagree with what was actually imported:
--
--   a month is finished when every round that belongs to it has ended,
--   and every source has been imported past the last of those endings.
--
-- Both halves are needed. Coverage alone is not enough: a round can be anchored
-- to August and run into September, and a file that stops on 31 August has not
-- seen the end of it. Round endings alone are not enough either, for the obvious
-- reason that a round ending is not a round being imported.
--
-- WHAT THIS ADDS. One view. It projects the anchor, which is the only thing
-- missing — v_rounds is `select r.*` and the anchor is used in its WHERE clause
-- but never selected, so no caller can see which period a round landed in.
--
--   20260911100000 line 261: fo_round_anchor(...) is an argument, not a column.
--
-- It deliberately does NOT recompute the anchor rule. fo_round_anchor is the one
-- definition, it is IMMUTABLE and does no lookup, and the whole point of the
-- month-boundary fix was that one function decides this. A second copy in
-- TypeScript would be the same bug wearing a different hat.
--
-- SAFE TO RE-RUN. Creates a view, grants select, touches no table and no data.

create or replace view v_round_period as
select
  r.client_id,
  r.round_id,
  r.code,
  r.start_date,
  r.end_date,
  fo_round_anchor(r.code, r.start_date, r.end_date)                 as anchor,
  to_char(fo_round_anchor(r.code, r.start_date, r.end_date), 'YYYY-MM') as period
from rounds r;

-- Same audience as v_rounds. This exposes no metric and no person: a round code,
-- two dates, and which month they fall in.
grant select on v_round_period to anon, authenticated;

-- ── PROOF ──────────────────────────────────────────────────────────────────
-- Shely has two rounds that straddle a boundary, and they are the reason the
-- anchor exists. Both must report the NAMED month, not the starting one:
--
--   0826-01  2026-07-31 → 2026-08-06   must read period = 2026-08
--   0926-01  2026-08-28 → 2026-09-03   must read period = 2026-09
--
-- select code, start_date, end_date, period
--   from v_round_period where client_id = 'shely' order by start_date;
