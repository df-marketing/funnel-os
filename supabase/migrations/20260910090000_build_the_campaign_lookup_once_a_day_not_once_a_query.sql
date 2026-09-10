-- A FIFTY-TWO ROW TABLE IS BEING REBUILT FOUR TIMES PER PAGE.
--
-- Measured, not guessed:
--
--   events, count only              0.12–0.24s
--   v_event_attribution, count      0.19–0.25s     cheap
--   v_attributed_events, count      0.60–0.79s     +0.45s appears here
--   v_campaign_dimensions           0.23s          52 rows
--   v_contact_entry                 0.22s
--
-- Five views build v_campaign_dimensions independently — v_ads,
-- v_attributed_events, v_contact_entry, v_round_markets, v_client_countries —
-- and v_attributed_events reads v_contact_entry, which builds it again. One
-- page load reading v_ads, v_attributed_events and v_rounds therefore derives
-- the same fifty-two rows four or more times.
--
-- Each build is a DISTINCT over 1,855 ad rows unioned with 3,035 events, then
-- `fo_resolve` — the rules engine, about 0.45ms a call — over every distinct
-- campaign, twice, for market and landing page. Roughly 0.1 to 0.15 seconds,
-- paid four times, on every read, to produce a result that only changes when
-- somebody imports a file or edits a rule.
--
-- That is the database floor the app has been living with: about 1.1 seconds
-- for any read, of which half is this.
--
-- ── WHY THIS ONE AND NOT v_contact_entry ───────────────────────────────────
--
-- v_contact_entry costs the same and is NOT safe to cache. It calls
-- fo_attribution_model(), which reads the transaction's `funnel.attribution`
-- setting, so its rows differ per credit model. A materialised copy would
-- freeze one model and quietly serve it to everybody — the Credit selector
-- would still move and the numbers would stop following it.
--
-- v_campaign_dimensions reads no session setting at all. It is a pure function
-- of ads_performance, events and dimension_values. That is what makes it
-- cacheable and v_contact_entry not.
--
-- ── WHAT GOES STALE, AND HOW BADLY ─────────────────────────────────────────
--
-- Between refreshes, a campaign imported since the last refresh has no row
-- here. Every consumer reads it as `coalesce(d.market, r.country)` or an outer
-- join, so a missing row falls back to the round's own country and the landing
-- page reads as unattributed. The failure is directional — it understates
-- attribution, never invents it — and it is the same direction as the unmatched
-- queue.
--
-- It is refreshed on every import commit and by the Refresh data button. A rule
-- change made in SQL needs a manual refresh:
--
--   select fo_refresh_lookups();

begin;

create materialized view if not exists mv_campaign_dimensions as
with campaigns as materialized (
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

-- REFRESH CONCURRENTLY requires a unique index, and it is what keeps reads
-- serving while the refresh runs. `campaign` is null for one row per client —
-- the events with no utm_campaign — and unique indexes treat nulls as distinct,
-- so the coalesce is what makes the key actually unique.
create unique index if not exists mv_campaign_dimensions_key
  on mv_campaign_dimensions (client_id, coalesce(campaign, ''));

grant select on mv_campaign_dimensions to anon, authenticated;

-- The view keeps its name and its columns, so none of the five consumers
-- changes. They stop deriving and start reading.
create or replace view v_campaign_dimensions as
select client_id, campaign, market, landing_page from mv_campaign_dimensions;

grant select on v_campaign_dimensions to anon, authenticated;

comment on materialized view mv_campaign_dimensions is
  'Every distinct campaign resolved to its market and landing page, once. Five '
  'views derive this and one page load rebuilt it four times at ~0.15s each. '
  'Refreshed by fo_refresh_lookups() on every import commit and by the Refresh '
  'data button. A rule change made in SQL needs a manual refresh.';

/**
 * Refresh what is cached, and say so if it fails.
 *
 * SECURITY DEFINER because the caller is the service role during an import and
 * the anon role behind the Refresh button, and neither owns the matview.
 * search_path is pinned: a definer function that resolves names through the
 * caller's path is how a definer function becomes a way in.
 *
 * CONCURRENTLY so reads are never blocked. It needs the unique index above.
 */
create or replace function fo_refresh_lookups()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  refresh materialized view concurrently mv_campaign_dimensions;
  return 'mv_campaign_dimensions refreshed';
end;
$$;

grant execute on function fo_refresh_lookups() to anon, authenticated, service_role;

commit;

-- ── VERIFY — CONTENT FIRST ─────────────────────────────────────────────────
--
-- 1. THE SAME FIFTY-TWO ROWS. A cache serving different rows is worse than no
--    cache:
--
--      select count(*) from v_campaign_dimensions;              -- 52
--      select market, count(*) from v_campaign_dimensions
--       group by market order by market;
--        -- MY 2 · SG 28 · (null) 22
--
-- 2. THE TOTALS, unmoved:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
-- 3. THE CREDIT SELECTOR STILL MOVES. This is the one that would break if the
--    wrong view had been cached. Every model totals 83,927 and 0726-02 differs:
--
--      entry 23,173 · last_touch 13,876 · last_paid 14,173 · even_split 18,648.25
--
--    If those four become the same number, v_contact_entry has been frozen and
--    this migration is wrong.
--
-- 4. THE COUNTRY SPLIT, unmoved: MY 1 round 989.53 · SG 12 rounds 19,485.25.
--
-- 5. SPEED. v_attributed_events was 0.60–0.79s; expect roughly 0.3–0.45s.
--    fo_cut by_round was 1.12–1.18s. This does not make the app instant — it
--    removes about half the floor, and the rest is composed of six view layers
--    at 0.1–0.2s each, which is an instance-size question rather than a query
--    one.
