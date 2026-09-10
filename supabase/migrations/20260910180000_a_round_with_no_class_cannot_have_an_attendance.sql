-- A ROUND WITH NO CLASS CANNOT HAVE AN ATTENDANCE, AND THE TOTAL DISAGREED.
--
-- Acme's By round table showed attendance as "—" in every round column and 44
-- in Total. Both halves are individually defensible and together they say 44
-- people attended something that belongs to no round.
--
-- The per-round view is the one behaving correctly:
--
--   case when exists (… v_attendance_seen …)
--         and coalesce(cls.sessions, 0) > 0
--        then coalesce(ev.attendance, 0) end
--
-- `cls.sessions` counts round_sessions. A round with no scheduled class has
-- nothing anybody could have attended, so its attendance is unanswerable rather
-- than zero — which is the blank-is-not-zero rule doing exactly its job.
--
-- The fixture was incomplete: it created four bootcamp rounds and never said
-- when the bootcamp met. Real rounds have sessions; Shely's twelve all do. This
-- adds one class per acme round, on its end date.
--
-- ── WHAT THIS DOES NOT FIX ─────────────────────────────────────────────────
--
-- v_metrics_total has no equivalent gate, so it counted the 44 regardless. With
-- sessions present the two agree and the symptom goes, but a client onboarded
-- without session rows would see the same contradiction again: a total that no
-- column accounts for. That is worth deciding on its own — either the total
-- gates the same way, or the per-round view stops gating — and it is a
-- reporting decision rather than a fixture one, so it is written down here
-- rather than guessed at.
--
-- Zenith deliberately gets nothing. It books demos rather than running classes,
-- its journey has no attendance stage, and its attendance reads "—" in both
-- places already — which is the same rule agreeing with itself.

begin;

insert into round_sessions (session_id, round_id, session_date, session_label, ord)
select r.round_id || '·1', r.round_id, r.end_date,
       'Bootcamp ' || to_char(r.end_date, 'DD Mon YYYY'), 1
from rounds r
where r.client_id = 'acme_fitness'
on conflict (session_id) do nothing;

commit;

-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
-- 1. THE TWO NUMBERS NOW AGREE. Per round and total, read together:
--
--      select cut_key, m->>'att' as attendance
--        from fo_cut('v_metrics_by_round', 'acme_fitness');
--        -- 11 in each of the four rounds
--
--      select m->>'att' from fo_cut('v_metrics_total', 'acme_fitness');
--        -- 44, which is what the four columns now add to
--
-- 2. ZENITH IS UNCHANGED and still blank in both places — it has no attendance
--    stage and no classes, and "—" is the right answer twice.
--
-- 3. SHELY IS UNTOUCHED: 20,474.78 · 1,889 · 682 · 83,927.00.
--
-- ── UNDO ───────────────────────────────────────────────────────────────────
--   delete from round_sessions
--    where round_id in (select round_id from rounds where client_id = 'acme_fitness');
