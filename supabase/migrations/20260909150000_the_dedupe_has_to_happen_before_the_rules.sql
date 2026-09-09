-- THE DEDUPE HAS TO HAPPEN BEFORE THE RULES, AND A PUSHED-DOWN FILTER MOVES IT
-- AFTER.
--
-- Not a theory this time. The query plan for v_round_markets, 2,198ms total:
--
--   Hash Join                                     2169ms
--     -> HashAggregate  rows=122                     5ms   ← the round/campaign side
--     -> Hash            rows=30                  2163ms   ← v_campaign_dimensions
--          Join Filter: (fo_resolve(..., 'market', a_1.campaign, ...) IS NOT NULL)
--            Seq Scan on ads_performance  rows=1855    858ms
--          Join Filter: (fo_resolve(..., 'market', e_1.utm_campaign, ...) IS NOT NULL)
--            Seq Scan on events           rows=3035   1300ms
--
-- 2,158ms of the 2,198 is one function. `fo_resolve` costs about 0.45ms a call
-- — it walks dimension_values applying regexes — and it is being called 4,890
-- times: once per raw ad row and once per raw event.
--
-- It is meant to be called 52 times. `v_campaign_dimensions` deduplicates to 52
-- distinct campaigns FIRST and resolves each one once. That is the entire
-- reason it exists.
--
-- ── WHY THE DEDUPE STOPPED HAPPENING FIRST ─────────────────────────────────
--
-- A view is not a table. `v_campaign_dimensions` is simple enough for Postgres
-- to flatten into whatever reads it, and once flattened, a consumer's
--
--     where d.market is not null
--
-- becomes a qual the planner may push BELOW the view's internal DISTINCT. Read
-- the plan again: the filter is evaluated on the sequential scans, before any
-- aggregation. The dedupe still happens — 1,855 rows become 23 — but it happens
-- to the OUTPUT of the rules rather than the input.
--
-- This is also why v_ads has never been slow. It reads the same view with the
-- same join and takes 0.24s, because it uses `coalesce(d.market, r.country)`
-- and has no IS NOT NULL predicate to push. Nothing about the join was ever the
-- problem. The predicate was.
--
-- So it is fixed once, at the source, rather than in each of the six consumers
-- — and the consumers that were never broken are not touched.
--
-- ── WHAT AS MATERIALIZED DOES HERE ─────────────────────────────────────────
--
-- It is an optimisation fence. A materialised CTE is evaluated exactly once
-- into a tuplestore and NO qual from outside can be pushed below it. The 52
-- distinct campaigns are computed, then `fo_resolve` runs 104 times — twice per
-- campaign, for market and landing page — and every consumer probes the result.
--
-- 33 used the same keyword and barely helped, for a reason this plan explains:
-- it fenced the CTE in v_client_countries, but the `where market is not null`
-- INSIDE that CTE still pushed below the DISTINCT inside v_campaign_dimensions.
-- The fence was one level too high. This puts it where the dedupe is.

begin;

create or replace view v_campaign_dimensions as
with campaigns as materialized (
  -- MATERIALIZED is load-bearing, not decoration. Without it a consumer's
  -- `where market is not null` is pushed below this DISTINCT and the rules run
  -- 4,890 times instead of 52.
  select distinct r.client_id, a.campaign
  from ads_performance a
  join rounds r on r.round_id = a.round_id
  union
  select distinct r.client_id, e.utm_campaign as campaign
  from events e
  join rounds r on r.round_id = e.round_id
)
select c.client_id, c.campaign,
       fo_resolve(c.client_id, 'market', c.campaign) as market,
       fo_resolve(c.client_id, 'landing_page', c.campaign) as landing_page
from campaigns c;

grant select on v_campaign_dimensions to anon, authenticated;

comment on view v_campaign_dimensions is
  'Each distinct campaign resolved once. The CTE is MATERIALIZED deliberately: '
  'it fences the dedupe so a consumer''s "where market is not null" cannot be '
  'pushed below it. Unfenced, fo_resolve ran 4,890 times instead of 52 and this '
  'view cost 2.2 seconds instead of 0.05.';

commit;

-- ── WHAT THIS SHOULD DO, AND HOW TO KNOW IT DID ────────────────────────────
--
-- Nothing about WHICH rows come back changes. Every campaign resolves to the
-- market and landing page it resolved to before; only the number of times the
-- question is asked changes. So the check is speed AND sameness, and the
-- sameness matters more.
--
-- 1. THE PLAN. Re-run query 1 from file 34. `fo_resolve` should appear ABOVE
--    the aggregation, not as a Join Filter on a sequential scan, and the row
--    counts beside it should be in the dozens rather than 1,855 and 3,035.
--
--      explain (analyze, buffers, verbose) select * from v_round_markets;
--
--    Expect Execution Time well under 100ms, from 2,198ms.
--
-- 2. THE SAME ANSWERS. This is the one that matters — a fast view returning
--    different rows is worse than a slow one:
--
--      select * from v_campaign_dimensions order by client_id, campaign;
--        -- 52 rows, unchanged
--
--      select * from v_round_markets order by market, round_id;
--        -- 13 rows: MY on 0926-01, SG on the other twelve
--
--      select * from v_client_countries where client_id = 'shely';
--        -- shely MY 4 · shely SG 12
--
-- 3. THE COUNTRY FILTER, through the anon key and not this editor:
--
--      country=MY     4 rounds
--      country=SG    12 rounds
--      country=SG,MY 13 rounds
--
--    A filter is a set — both must never return fewer than one.
--
-- 4. THE TOTALS, unmoved, because a total that does not move is not proof but a
--    total that moves is the end of the conversation:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
-- 5. NOTHING GOT SLOWER. v_ads was never broken and is read everywhere; it was
--    0.24s. If it has grown, this fence has cost more than it saved and it
--    should come back out.
