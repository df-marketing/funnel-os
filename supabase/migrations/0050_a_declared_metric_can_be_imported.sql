-- ═══════════════════════════════════════════════════════════════════════════
-- A declared metric gets a file to drop.
--
-- Phase 4, and the last one. 0048 made the vocabulary a table, 0049 made a
-- declared metric produce figures. Both assumed the events were already there.
-- Nothing could put them there: the importer knew five sources by name, and
-- import_batches would refuse a sixth.
--
-- The pipeline change is in TypeScript and is mostly a deletion. The attendance
-- branch was the only one shaped "a person, a round, and when", which is the
-- shape of EVERY per-person stage — attendance was just the first example. It
-- now branches on the source spec declaring an event type rather than on the
-- name 'attendance', so a declared stage runs the identical path, dedupe,
-- parking and restatement checks included. The generic route is therefore the
-- one production has been exercising since May.
--
-- One thing stays specific to attendance, gated on the event type rather than
-- the source name: close_round_id. It says which class a purchase closed at,
-- and 0020's ROAS rule rests on it. An appointment is not the room somebody
-- bought in, so a declared stage must not move that credit.
--
-- This migration is only the constraint. import_batches.source has listed its
-- permitted values since 0001 and was last widened by 0032 to admit 'scroll';
-- widening it by hand for every future metric is the thing this work exists to
-- stop, so it admits the whole `stage:` family by pattern instead.
--
-- A check constraint cannot look in journey_metrics, so the pattern is as far
-- as SQL goes here — but nothing reaches this table without going through
-- planImport, which reads journey_metrics first and refuses a metric nobody
-- declared, by name. The constraint stops a typo becoming a new source; the
-- pipeline stops it becoming an event.
--
-- ROLLBACK:
--   alter table import_batches drop constraint if exists import_batches_source_check;
--   alter table import_batches add constraint import_batches_source_check
--     check (source in ('ads', 'leads', 'attendance', 'sales', 'scroll'));
-- ═══════════════════════════════════════════════════════════════════════════

alter table import_batches drop constraint if exists import_batches_source_check;

alter table import_batches add constraint import_batches_source_check
  check (
    source in ('ads', 'leads', 'attendance', 'sales', 'scroll')
    or source ~ '^stage:[a-z][a-z0-9_]{1,40}$'
  );

comment on constraint import_batches_source_check on import_batches is
  'The five built-in sources, plus stage:<metric> for anything declared in '
  'journey_metrics. The pattern is deliberately loose; planImport checks the '
  'metric exists and is not core before any row is written.';
