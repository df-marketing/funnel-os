-- fo_refresh_lookups() HAS NEVER WORKED.
--
--   ERROR: 55000: cannot refresh materialized view "public.mv_campaign_dimensions"
--          concurrently
--   HINT:  Create a unique index with no WHERE clause on one or more columns of
--          the materialized view.
--
-- Migration 20260910090000 created the index it needed, or thought it did:
--
--   create unique index mv_campaign_dimensions_key
--     on mv_campaign_dimensions (client_id, coalesce(campaign, ''));
--
-- That enforces uniqueness correctly and is useless for the purpose. REFRESH
-- MATERIALIZED VIEW CONCURRENTLY requires a unique index that "uses only column
-- names" — no partial index, and NO EXPRESSIONS. The coalesce is exactly what
-- disqualifies it, and it was there for a good reason: campaign is nullable, so
-- a plain index would treat the null rows as distinct from each other.
--
-- ── WHY NOBODY NOTICED ─────────────────────────────────────────────────────
--
-- The matview is populated by CREATE, so it has been correct since the day it
-- was made and every screen reading it has been right. Nothing ever refreshed
-- it, and nothing complained, because the refresh after an import commit was
-- written to log and continue rather than fail — deliberately, so a refresh
-- problem could not turn a good import into an error somebody retries.
--
-- That decision was right and it hid this. An import since then would have
-- written its rows, succeeded, and left any campaign it introduced resolving to
-- no market and no landing page, with the only trace in a server log. It took
-- inserting two new clients to surface it, which is the argument for inserting
-- two new clients.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- Add a second unique index on plain column names, and keep the first one. The
-- expression index is what actually guarantees uniqueness across the null
-- campaigns; the plain one is what CONCURRENTLY will accept. Both on 52 rows
-- cost nothing, and neither is load-bearing for reads.
--
-- Uniqueness of (client_id, campaign) is guaranteed by the matview's own body,
-- which is a SELECT DISTINCT — so at most one null-campaign row per client can
-- exist, and the plain index cannot be violated by data this view can produce.

begin;

create unique index if not exists mv_campaign_dimensions_plain_key
  on mv_campaign_dimensions (client_id, campaign);

comment on index mv_campaign_dimensions_plain_key is
  'Plain column names, because REFRESH MATERIALIZED VIEW CONCURRENTLY refuses '
  'an expression index. mv_campaign_dimensions_key beside it is the one that '
  'enforces uniqueness across null campaigns; this one exists so the refresh '
  'is legal at all.';

commit;

-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
-- 1. THE REFRESH RUNS. This is the whole point, and it has never returned
--    successfully before:
--
--      select fo_refresh_lookups();
--        -- mv_campaign_dimensions refreshed
--
-- 2. THE NEW CLIENTS' CAMPAIGNS NOW RESOLVE. Until the refresh above, acme's
--    campaigns were absent from the lookup and read as having no market:
--
--      select client_id, market, count(*) from v_campaign_dimensions
--       where client_id in ('acme_fitness','zenith_saas')
--       group by 1,2 order by 1,2;
--        -- acme_fitness MY 2 · acme_fitness SG 2 · zenith_saas (null) 2
--
-- 3. SHELY IS UNCHANGED, because a refresh recomputes the same rows from the
--    same tables:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
--    and its country filter still splits MY 1 / SG 12.
