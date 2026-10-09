-- 1026-01's whole round is stored four months early.
--
-- WHAT HAPPENED.
--
-- lib/import/csv.ts decided slash-date order ONE VALUE AT A TIME. A value can
-- only prove its own order when one half exceeds 12, and where nothing proved
-- it the parser fell back to day-first — right for an SG export, and the
-- reason the fallback exists.
--
-- Shely's attendance column held four dates:
--
--   9/17/2026   seventeen is no month -> month-first, read correctly
--   9/24/2026   same
--   9/30/2026   same
--   10/6/2026   both halves under 13 -> nothing proved -> day-first default
--
-- So one column was read two different ways, and the one it read wrongly was
-- the ambiguous one, which by definition looks fine. 10/6/2026 became 10 June
-- 2026. Nothing threw, nothing was refused, and the figures all added up.
--
-- WHAT IT COST. Every event of round 1026-01 — 143 leads, 40 attendances and
-- 6 sales, 189 rows — sits on 2026-06-10 instead of 2026-10-06. The October
-- class shows nobody, which is what Henry reported as "attendance data is
-- blank", and June gains a crowd that was never there.
--
-- THE CODE IS FIXED SEPARATELY. inferDateOrder now reads the whole column
-- before any of it: three values prove month-first, so the fourth follows
-- them. A column where genuinely nothing proves either way still reads
-- day-first and now says so in a warning instead of deciding in silence.
-- This file only repairs what the old rule already wrote.
--
-- WHY ONLY THIS ROUND. Every round was scanned for events sitting far outside
-- it. 1026-01 is the only one with the signature — 189 events on a single day,
-- all three types at once. The others show one to three stray leads scattered
-- over weeks, which is an old lead registering for a later round and is
-- ordinary.
--
-- THE TIME OF DAY IS KEPT, not rewritten. The two instants present are
-- 15:59:59Z (23:59:59 local, the end-of-day stamp for a date with no time) and
-- 12:00:00Z (20:00 local, the class). Their order decides closing credit, so
-- the date moves and the clock does not.
--
-- SAFE TO RE-RUN — after the first run no row matches 2026-06-10 any more.

begin;

update events
   set event_date = (date '2026-10-06'
                     + (event_date at time zone 'Asia/Singapore')::time)
                    at time zone 'Asia/Singapore'
 where round_id = '1026-01'
   and (event_date at time zone 'Asia/Singapore')::date = date '2026-06-10';

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. The round happened in October, and the clock is untouched:
--
--      select event_type,
--             (event_date at time zone 'Asia/Singapore')::date as local_day,
--             to_char(event_date at time zone 'Asia/Singapore', 'HH24:MI:SS') as local_time,
--             count(*)
--        from events where round_id = '1026-01'
--       group by 1,2,3 order by 1,2;
--
--    Expect 143 lead and 40 attendance on 2026-10-06 at 23:59:59, 6 sale on
--    2026-10-06 at 20:00:00, and the one sale already on 2026-09-30.
--
-- 2. Nothing is left in June:
--
--      select count(*) from events
--       where (event_date at time zone 'Asia/Singapore')::date = date '2026-06-10';
--
--    Expect 0.
--
-- 3. The four September/October rounds now read the way their classes ran:
--
--      select r.round_id, r.session_date,
--             count(*) filter (where e.event_type = 'lead')       as leads,
--             count(*) filter (where e.event_type = 'attendance') as attendance,
--             count(*) filter (where e.event_type = 'sale')       as sales
--        from rounds r join events e on e.round_id = r.round_id
--       where r.round_id in ('0926-02','0926-03','0926-04','1026-01')
--       group by 1,2 order by 1;
--
--    Expect each round's leads and attendance dated on its own class day.
--
-- 4. Nothing was created or destroyed — only moved:
--
--      select count(*) from events where round_id = '1026-01';
--
--    Expect 190 (189 moved plus the sale already dated 2026-09-30).
