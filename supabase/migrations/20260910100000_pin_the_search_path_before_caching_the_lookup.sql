-- A MATERIALISED VIEW DOES NOT RUN WITH YOUR SEARCH PATH.
--
-- Migration 44 failed on its first statement:
--
--   ERROR: 42P01: relation "dimension_values" does not exist
--   QUERY:  select ... from dimension_values v where v.client_id = p_client ...
--   CONTEXT: SQL function "fo_resolve" during inlining
--
-- `dimension_values` exists and is readable — the app reads it constantly. What
-- does not exist is the search path that would find it. Postgres runs
-- CREATE MATERIALIZED VIEW and REFRESH MATERIALIZED VIEW with a deliberately
-- restricted search_path, because a matview is refreshed later, by somebody
-- else, possibly with different privileges: an unqualified name inside one is a
-- place to hide a table that runs as the refresher. So unqualified references
-- resolve against pg_catalog and nothing else, and `fo_resolve`, which names
-- `dimension_values` bare, cannot see it.
--
-- The functions are what need fixing, not the matview. `fo_resolve` and
-- `fo_rule_ok` are called from ordinary views today and happen to work because
-- the caller's path contains public. That is a coincidence rather than a
-- guarantee, and it is the same coincidence that would break a cron job, a
-- background refresh or any caller that pins its own path.
--
-- Pinning it on the function is also the correct answer for `fo_refresh_lookups`
-- being SECURITY DEFINER: a definer function whose callees resolve names
-- through the caller's path is how a definer function becomes a way in.
--
-- ── RUN THIS, THEN RUN 44 AGAIN. ───────────────────────────────────────────
-- 44 is unchanged and safe to re-run: every statement in it is IF NOT EXISTS
-- or CREATE OR REPLACE.

begin;

-- Both are pure readers of dimension_values. Pinning the path changes nothing
-- about what they return; it removes their dependence on who is asking.
alter function fo_resolve(text, text, text, text, text, text)
  set search_path = public, pg_temp;

alter function fo_rule_ok(jsonb, text, text, text, text)
  set search_path = public, pg_temp;

commit;

-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
-- 1. THE RULES STILL RESOLVE THE SAME WAY. This is the check that matters —
--    a function that resolves differently would re-file spend between markets
--    while every total stayed put:
--
--      select market, count(*) from v_campaign_dimensions
--       group by market order by market;
--        -- MY 2 · SG 28 · (null) 22
--
--      select fo_resolve('shely', 'market', 'DF_MY_Preview_Sprint1_0926_01_LP1GHL');
--        -- MY
--
-- 2. THEN RUN 44. The CREATE MATERIALIZED VIEW should now succeed, and
--    fo_refresh_lookups() should return 'mv_campaign_dimensions refreshed'.
--
--      select fo_refresh_lookups();
--
-- 3. THE TOTALS, unmoved:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
