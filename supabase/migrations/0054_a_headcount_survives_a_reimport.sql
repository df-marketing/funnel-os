-- ═══════════════════════════════════════════════════════════════════════════
-- 0054 — a headcount has to survive being counted twice.
--
-- WHAT WAS WRONG. 0051 counts people the export names and cannot identify: a
-- webinar roster carries "Katherine" with no address, and she is somebody who
-- ARRIVED even though she is nobody the app can name. Those rows are written
-- with contact_id null and deduped, within one file, on anon:<name>.
--
-- The key never reached the database. seenEvents is rebuilt on every import
-- from the rows already stored, as
--
--     event_type | contact_id ?? '' | round_id | day | product
--
-- and for an anonymous row that is event_type||round|day — the same string for
-- every anonymous person in that room. It matches nothing the writer produces,
-- because the writer keys on the name. So a re-import cannot see them, and
-- writes all of them again.
--
-- Shely's attendance went 578 -> 790 on a second import of the identical file.
-- 210 anonymous heads became 422. Nothing about the room changed.
--
-- The comment on anonKey says its only job is "to make a headcount idempotent,
-- so re-dropping the same roster counts the same people once rather than
-- twice". This is the column that makes that true.
--
-- WHY A COLUMN AND NOT A CONTACT. Because they are not a person. The whole
-- point of 0051 is that this row can never take revenue, never close a sale and
-- never be resolved into somebody — inventing a contact to hold a dedupe handle
-- would undo the distinction it exists to draw. anon_key is a handle for the
-- ROW, not an identity for the human.
--
-- It is deliberately not unique. Two people genuinely called "Katherine" in one
-- room collapse to one head, which under-counts by one and cannot over-count —
-- the direction this app errs in everywhere — and a constraint would turn that
-- accepted imprecision into a failed import.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table events add column if not exists anon_key text;

comment on column events.anon_key is
  'Dedupe handle for a row the export named but could not identify. NOT an '
  'identity: never matched against a contact, never used to attach revenue. '
  'Null on every row that has a contact_id. See 0051 and 0054.';

-- Only anonymous rows carry one, and they are looked up by round.
create index if not exists idx_events_anon_key
  on events (round_id, anon_key)
  where anon_key is not null;

commit;
