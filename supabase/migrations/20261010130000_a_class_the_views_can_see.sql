-- Four rounds hold 175 attendances and every one of them reports a dash.
--
-- WHAT IS WRONG.
--
-- A round's class lives in TWO places and only one of them is read.
--
--   rounds.session_date   where the class is typed, by hand or by the form
--   round_sessions        the table every metric view actually reads
--
-- 0025 split them when a round stopped being limited to one class — "a round
-- runs however many classes it runs" — and backfilled every round that existed
-- that day. Nothing has written round_sessions since. Each round created by
-- hand after 0926-01 got a session_date and no session row.
--
-- v_round_sessions is built from round_sessions alone and never looks at
-- rounds.session_date:
--
--     create view v_round_sessions as
--     select ... from round_sessions s join v_rounds r on r.round_id = s.round_id;
--
-- and v_metrics_by_round gates attendance on it:
--
--     case when exists (select 1 from v_attendance_seen ...)
--           and coalesce(cls.sessions, 0) > 0
--          then coalesce(ev.attendance, 0) end
--
-- No session row, no class, so the answer is ABSENT rather than a count. Which
-- is the right behaviour for a round that genuinely ran no class, and exactly
-- wrong for one whose class is sitting in the next column.
--
-- MEASURED. v_attributed_events already holds every one of these:
--
--     0926-02  52 attendance      0926-04  38 attendance
--     0926-03  45 attendance      1026-01  40 attendance
--
-- The events were always there. Nothing was lost and nothing needs importing;
-- the view could not see a class to hang them on. This is what Henry reported
-- as "attendance data is blank".
--
-- THE SCREEN WAS ABOUT TO DO IT AGAIN. app/api/rounds/route.ts wrote
-- rounds.session_date and not round_sessions, so every round created through
-- the new Step 0 form would have reported no attendance. Fixed in the same
-- commit as this file.
--
-- ── 1 · THE MISSING SESSION ROWS ──────────────────────────────────────────
--
-- Same shape 0025 used, so a row written here and a row written by that
-- migration are indistinguishable: session_id is `<round>·1`, ord is 1.
-- Every round with a class and no session row, not just the five known ones,
-- because any other client has been accumulating the same gap in silence.

begin;

insert into round_sessions (session_id, round_id, session_date, session_label, ord)
select r.round_id || '·1', r.round_id, r.session_date,
       coalesce(r.session_label, 'Class ' || to_char(r.session_date, 'DD Mon YYYY')), 1
  from rounds r
 where r.session_date is not null
   and not exists (select 1 from round_sessions s where s.round_id = r.round_id)
on conflict (session_id) do nothing;

-- ── 2 · AND SO IT CANNOT HAPPEN AGAIN ─────────────────────────────────────
--
-- The backfill above fixes today. This fixes the shape: a round whose class is
-- recorded on the round itself and nowhere else is still a round with a class,
-- and the view now says so.
--
-- `not exists` rather than a plain union, so a round that has real session
-- rows keeps exactly those and does not gain a duplicate of its first one.
-- Rounds that run several classes are unaffected.
--
-- The synthesised id matches 0025's convention, so if the row is later written
-- into round_sessions properly it replaces this one rather than joining it.

create or replace view v_round_sessions as
select s.session_id, s.round_id, r.client_id, r.product_id,
       s.session_date, s.session_label, s.ord
  from round_sessions s
  join v_rounds r on r.round_id = s.round_id
union all
select r.round_id || '·1', r.round_id, r.client_id, r.product_id,
       r.session_date,
       coalesce(r.session_label, 'Class ' || to_char(r.session_date, 'DD Mon YYYY')), 1
  from rounds r
  join v_rounds vr on vr.round_id = r.round_id
 where r.session_date is not null
   and not exists (select 1 from round_sessions s where s.round_id = r.round_id);

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. Every round with a class now has one the views can see:
--
--      select r.round_id, r.session_date, count(v.session_id) as sessions
--        from rounds r
--        left join v_round_sessions v on v.round_id = r.round_id
--       where r.client_id = 'shely'
--       group by 1,2 order by 1;
--
--    Expect every round with a session_date to show at least 1, and 0926-02,
--    0926-03, 0926-04, 1026-01 and 1026-02 in particular.
--
-- 2. No round gained a duplicate class:
--
--      select round_id, session_date, count(*)
--        from v_round_sessions group by 1,2 having count(*) > 1;
--
--    Expect no rows.
--
-- 3. THE POINT — attendance appears where it always was:
--
--      select cut_key, m->>'att' as attendance, m->>'leads' as leads
--        from fo_cut('v_metrics_by_round', 'shely')
--       order by cut_key;
--
--    Expect 0926-02: 52, 0926-03: 45, 0926-04: 38, 1026-01: 40 — and every
--    older round unchanged, 0926-01 still 103 and 0526-02 still 50.
--
-- 4. Nothing was invented. The count has to equal the events that already
--    existed before this file ran:
--
--      select round_id, count(*) from events
--       where event_type = 'attendance'
--         and round_id in ('0926-02','0926-03','0926-04','1026-01')
--       group by 1 order by 1;
--
--    Expect the same four numbers as check 3.
