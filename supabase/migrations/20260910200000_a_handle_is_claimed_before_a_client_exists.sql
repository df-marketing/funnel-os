-- A HANDLE IS CLAIMED BEFORE THE CLIENT EXISTS.
--
-- AcqOS creates a client at signup, self-serve, with no human in the loop. It
-- cannot push the funnel then — the Growth Journey has no volumes yet — so
-- onboarding is two moments, not one:
--
--   signup                    reserve the handle
--   Growth Journey filled in  push the funnel, and the client appears here
--
-- The gap between them is the whole problem. Between those two moments the slug
-- is unclaimed, and a second signup deriving the same slug from a similar
-- company name would take it. Worse, GT's funnel-schema route deliberately
-- treats `createClient: true` on an existing client as a successful retry — it
-- REPLACES the funnel and reports created: false — which is right for a retry
-- and catastrophic for a collision. Today the slug is the only identity GT
-- holds, so it cannot tell those two apart.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--
-- One column: the client's id in AcqOS. That is the second identity that makes
-- the two cases distinguishable — same handle and same uuid is a retry, same
-- handle and a different uuid is a collision and must be refused.
--
-- It lives on client_flags rather than a new table for a reason worth stating:
-- v_clients is built FROM client_journey_config and LEFT JOINs client_flags, so
-- a flags row with no journey is INVISIBLE to the app. No switcher entry, no
-- tabs, no half-created client sitting in front of anybody. That is exactly
-- what a reservation should look like — the namespace is taken and nothing else
-- has happened.
--
-- ── WHY NOT LET THE FIRST PUSH BIND IT ─────────────────────────────────────
--
-- AcqOS caught this and they are right: if funnel-schema were allowed to
-- establish the binding, an unclaimed handle would still be racy in precisely
-- the window the claim exists to close. The claim writes it. funnel-schema only
-- ever verifies it.

begin;

alter table client_flags
  add column if not exists source_client_id uuid,
  add column if not exists claimed_at timestamptz;

/**
 * One AcqOS client holds one GroundTruth handle, and vice versa.
 *
 * Partial, because every client that predates this — shely, northsea_supply
 * and the two fixtures — has no AcqOS id and must stay legal. Null means "not
 * claimed through AcqOS", which is a real state and not a defect.
 */
create unique index if not exists client_flags_source_client_id_key
  on client_flags (source_client_id) where source_client_id is not null;

comment on column client_flags.source_client_id is
  'This client''s id in AcqOS (clients.id). Written once by the handle claim at '
  'signup and only verified thereafter — funnel-schema compares against it and '
  'never establishes it, or the handle is racy in the window the claim exists '
  'to close. Null on clients that predate the wire.';

comment on column client_flags.claimed_at is
  'When the handle was reserved. A row with claimed_at and no journey config is '
  'a reservation: invisible to v_clients, which is what a reservation should '
  'look like.';

commit;

-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
-- 1. THE EXISTING CLIENTS ARE UNTOUCHED AND STILL VISIBLE. A reservation is
--    invisible; a real client must not become one:
--
--      select client_id, currency, source_client_id from client_flags order by 1;
--        -- four rows, all with source_client_id null
--
--      select client_id from v_clients order by 1;
--        -- shely, northsea_supply, acme_fitness, zenith_saas — unchanged
--
-- 2. A RESERVATION IS INVISIBLE. Prove it before trusting it:
--
--      insert into client_flags (client_id, source_client_id, claimed_at)
--      values ('_probe', gen_random_uuid(), now());
--
--      select count(*) from v_clients where client_id = '_probe';   -- 0
--
--      delete from client_flags where client_id = '_probe';
--
-- 3. TOTALS UNMOVED: 20,474.78 · 1,889 · 682 · 83,927.00.
