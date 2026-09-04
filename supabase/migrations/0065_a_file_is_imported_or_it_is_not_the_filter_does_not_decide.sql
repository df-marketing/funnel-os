-- ═══════════════════════════════════════════════════════════════════════════
-- 0065 — a file is imported or it is not; the filter does not get a say.
--
-- Blank is never zero in this app, and the three "seen" views are what enforce
-- it: a client with no sales file shows blank purchases rather than a confident
-- 0. That is right, and they were asking the wrong question.
--
-- All three read v_events, which is FILTERED. So the gate answered "are there
-- sales in the cut I am currently looking at" instead of "has this client
-- imported sales at all". Any filter that removes every sale turned a known zero
-- into an unknown:
--
--     country = MY    247 leads · 54 attended · purchases BLANK · ROAS BLANK
--
-- Malaysia's sales are not unknown. The sales file covers September, every
-- Malaysian lead is in it, and none of them bought. Zero is the finding — 247
-- leads at $4.01 against Singapore's $26.54, a 21.9% show rate against 37.8%,
-- and nought at the end of it. Printed as a blank, that reads as missing data
-- and the one conclusion worth drawing is invisible.
--
-- Seen-ness is a property of the import, not of the cut. These now read the base
-- tables, so they answer the same regardless of which filter is standing.
--
-- What changes: cells that are blank today become 0 where the file is in and the
-- filter genuinely found none. No cell that already shows a number changes, and
-- a client who has not imported a file still gets blanks. Rates derived from a
-- true zero follow it — MY reads ROAS 0.00 rather than blank — while CPA stays
-- blank, because cost per acquisition over no acquisitions is not zero, it is
-- undefined.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- The join to rounds is only to reach client_id. rounds is the base table, so
-- no funnel.* setting can narrow it.
create or replace view v_sales_seen as
select distinct r.client_id
from events e join rounds r on r.round_id = e.round_id
where e.event_type = 'sale';

create or replace view v_leads_seen as
select distinct r.client_id
from events e join rounds r on r.round_id = e.round_id
where e.event_type = 'lead';

create or replace view v_attendance_seen as
select distinct r.client_id
from events e join rounds r on r.round_id = e.round_id
where e.event_type = 'attendance';

grant select on v_sales_seen, v_leads_seen, v_attendance_seen to anon, authenticated;

comment on view v_sales_seen is
  'Whether this client has EVER imported a sales file. Deliberately reads the '
  'base tables and not v_events: seen-ness is a fact about the import, and a '
  'filter that removes every sale has found a zero, not lost the file.';

commit;
