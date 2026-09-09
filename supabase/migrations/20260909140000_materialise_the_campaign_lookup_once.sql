-- ONE CHANGE, ON THE SAFEST SURFACE, TO TEST THE MECHANISM.
--
-- This is both a fix and an experiment, and it is deliberately small. Three
-- attempts have failed and one of them broke the app; this one changes a single
-- view that cannot move a number, and either it gets ten times faster or the
-- theory is wrong and nothing else gets tried on it.
--
-- ── WHAT IS ACTUALLY SLOW ──────────────────────────────────────────────────
--
-- Not the country filter. `v_client_countries` — the sidebar's country list —
-- times out on its own, and it runs on EVERY page load. Three seconds are spent
-- failing it before the app's fallback even starts, on every click. That is the
-- "why is everything slow" question, and it has nothing to do with which filter
-- is selected.
--
-- ── WHEN IT STARTED ────────────────────────────────────────────────────────
--
-- 0063 built the list from a plain function call:
--
--     select r.client_id, fo_country(a.campaign) as country
--     from ads_performance a join rounds r on r.round_id = a.round_id
--
-- The retired-column drop replaced that with a join, here and in five other
-- places:
--
--     join v_campaign_dimensions d
--       on d.client_id = r.client_id
--      and d.campaign is not distinct from a.campaign
--
-- That is where the cost came from. It was marginal rather than fatal until an
-- unrelated update of 1,401 event rows added enough work to push it over the
-- three-second limit, which is why it looked like it broke today.
--
-- ── WHY 31 DID NOT FIX IT ──────────────────────────────────────────────────
--
-- 31 replaced the un-hashable predicate with `coalesce(x, '') = coalesce(y, '')`
-- and the view stayed at 2.4 seconds. So being un-hashable was not the whole
-- story, and the remaining explanation is the one thing not yet tried:
--
--     v_campaign_dimensions is 52 rows and 0.11 seconds ON ITS OWN.
--     Joined, the same 52 rows cost twenty times that.
--
-- A view is not a table. Postgres inlines it into the query that reads it, and
-- an inlined subquery containing a function — `fo_resolve`, the rules engine —
-- can be re-executed per row of whatever it is joined to. Fifty-two rows
-- computed once is 0.11s; computed again for every one of 1,855 ad rows and
-- 3,035 events is the timeout.
--
-- `AS MATERIALIZED` is the one thing that forbids that. It forces the CTE to be
-- evaluated exactly once into a tuplestore, and nothing in 29, 30 or 31 used
-- it.
--
-- ── WHAT THIS RISKS ────────────────────────────────────────────────────────
--
-- Nothing on a metric. `v_client_countries` populates the sidebar's country
-- buttons and is read by nothing that computes spend, leads, attendance or
-- revenue. The app already falls back to counting the list in TypeScript when
-- this view fails, which is why the buttons kept appearing while this was
-- timing out. Worst case here is that it stays as slow as it already is.

begin;

create or replace view v_client_countries as
with dims as materialized (
  -- MATERIALIZED is the whole point. Fifty-two rows, the rules run over them
  -- once, and the result is a tuplestore that the joins below probe instead of
  -- a subquery they re-run.
  select client_id, coalesce(campaign, '') as campaign, market
  from v_campaign_dimensions
  where market is not null
),
from_ads as (
  select r.client_id, d.market as country, a.round_id
  from ads_performance a
  join rounds r on r.round_id = a.round_id
  -- coalesce on both sides is null-safe like IS NOT DISTINCT FROM, and unlike
  -- it can be hashed — so this is a hash join against the tuplestore above.
  join dims d
    on d.client_id = r.client_id
   and d.campaign = coalesce(a.campaign, '')
),
from_events as (
  select r.client_id, d.market as country, e.round_id
  from events e
  join rounds r on r.round_id = e.round_id
  join dims d
    on d.client_id = r.client_id
   and d.campaign = coalesce(e.utm_campaign, '')
),
from_rounds as (
  -- A round that declares its own country counts, even with no traffic to
  -- vouch for it. Unchanged from 0063.
  select client_id, country, round_id from rounds where country is not null
),
all_of_them as (
  select * from from_ads
  union select * from from_events
  union select * from from_rounds
)
select client_id, country, count(distinct round_id)::integer as round_count
from all_of_them
group by client_id, country
order by client_id, country;

grant select on v_client_countries to anon, authenticated;

commit;

-- ── THE MEASUREMENT ────────────────────────────────────────────────────────
--
-- Say which of these happened. It decides whether the same shape gets applied
-- to the other five places or whether the theory is abandoned.
--
--   UNDER 0.3s   The mechanism is confirmed: an inlined view containing the
--                rules engine was being re-executed per row. The same wrapper
--                then goes on fo_round_country_pick's lookup and on the four
--                remaining copies, and the country filter should come back with
--                it.
--
--   STILL 3s     The theory is wrong, this is the fourth time, and I stop
--                proposing repairs until an EXPLAIN (ANALYZE) has been read.
--                The query to run in that case is at the bottom of file 32.
--
-- Expected content, unchanged either way — Shely's two countries with the round
-- counts the sidebar has always shown:
--
--   select * from v_client_countries where client_id = 'shely';
--
--     shely   MY    4
--     shely   SG   12
--
-- And the totals, which this cannot touch and which are checked anyway because
-- a total that does not move is not proof:
--
--   spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
