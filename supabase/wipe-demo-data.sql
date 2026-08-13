-- ═══════════════════════════════════════════════════════════════════════════
-- Clear the seeded demo data so real imports can be tested against a clean
-- database.
--
-- REVERSIBLE. To put the mockup back, run 0002_seed.sql — it wipes and
-- re-inserts everything in one transaction, so nothing here is one-way.
--
-- Deletes the DATA. Keeps the SETUP:
--   kept    clients, rounds, client_journey_config (stages, prices)
--   deleted contacts, events, ads_performance, unmatched_rows, import_batches
--
-- Rounds are kept deliberately — an import is refused outright if the round it
-- belongs to doesn't exist, and 0526-02 / 0526-03 are real.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

delete from unmatched_rows;
delete from events;
delete from ads_performance;
delete from import_batches;
delete from contacts;

commit;

-- Optional, run only if you want the two real rounds to sit next to each other
-- with no gap. Leads that opted in 20–22 May currently fall outside every round
-- window and get filed into 0526-02 by the date-window fallback.
--
--   update rounds set start_date = '2026-05-20'
--   where client_id = 'shely' and round_id = '0526-03';

-- Optional, the middle offer is configured at SGD 3,000 but the May data says
-- SGD 1,197.
--
--   update client_journey_config set unit_price = 1197
--   where client_id = 'shely' and stage_slug = 'middle';
