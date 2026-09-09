-- REVERT. RUN THIS FIRST, BEFORE READING THE REST.
--
-- Migration 31 made it worse. It was meant to trade a small cost on the
-- unfiltered path for a working country filter; the lookup did not get cheap,
-- so the app paid the cost and got nothing:
--
--                              before 31      after 31
--     v_rounds, no filter         0.18s         1.89s
--     fo_cut by_round, none       1.19s         TIMEOUT
--     fo_cut total, none          worked        TIMEOUT
--     country=MY                  TIMEOUT       TIMEOUT
--
-- Every metric view joins v_rounds, so making v_rounds unconditionally pay for
-- the markets lookup took down screens that had nothing to do with countries.
-- The database is not the problem — trivial reads are 60–150ms and
-- v_campaign_dimensions is 0.11s. This is my change.
--
-- I said in 31 that paying always would be an honest trade "once the lookup is
-- cheap". It is not cheap — v_round_markets is still 2.4 seconds for thirteen
-- rows — so the premise was wrong and the trade should not have shipped.
--
-- This puts v_rounds back to what 0071 defined and the retired-column drop
-- carried forward. That restores the app to the state it was in this morning:
-- everything works EXCEPT the country filter, which was already timing out
-- before any of this and is a separate, older fault.
--
-- The three things I got wrong, so the next attempt does not repeat them:
--
--   29  blamed dead tuples. ANALYZE changed nothing.
--   30  blamed how often the lookup ran. The lookup itself was the cost.
--   31  blamed the un-hashable join. Hashing it did not make the view fast,
--       and I shipped the "pay always" trade on a prediction instead of a
--       measurement.
--
-- v_round_markets and fo_country_selection are LEFT IN PLACE. Nothing on a
-- screen reads them now, they cost nothing unread, and the next attempt needs
-- them to measure against. fo_round_country_pick goes back to the definition
-- v_rounds is about to call.

begin;

-- The pick, as the retired-column drop left it: consults v_round_markets, which
-- is where the remaining cost lives. Unchanged in what it decides.
create or replace function fo_round_country_pick(p_round_id text, p_round_country text)
returns text
language sql
stable
as $$
  select case
    when fo_country_selection() is null then p_round_country
    when p_round_country = any(fo_country_selection()) then p_round_country
    else (
      select m.market from v_round_markets m
       where m.round_id = p_round_id
         and m.market = any(fo_country_selection())
       order by m.market
       limit 1
    )
  end;
$$;

grant execute on function fo_round_country_pick(text, text) to anon, authenticated;

-- 0071's definition, verbatim. No join, so no cost when no country is chosen —
-- which is the property 31 gave away.
create or replace view v_rounds as
select r.*
from rounds r
where fo_filter_people_ok(
        r.product_id,
        -- A country the round actually ran in, or NULL if it ran in none of the
        -- chosen ones. Never the selection itself.
        fo_round_country_pick(r.round_id, r.country),
        r.start_date, r.end_date
      );

grant select on v_rounds to anon, authenticated;

commit;

-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
-- Expect the app back, and the country filter still broken:
--
--   v_rounds, no filter        under 0.3s
--   fo_cut total, no country   20,474.78 · 1,889 · 682 · 83,927.00
--   fo_cut by_round, none      13 rounds, around a second
--   country=MY                 still times out — that is the OLD bug, not new
--
-- ── THEN, AND ONLY THEN ────────────────────────────────────────────────────
--
-- I have guessed three times. The next change should follow a measurement, so
-- run this and send me what it prints. It is read-only and takes seconds:
--
--   explain (analyze, buffers, format text)
--   select distinct p.round_id, d.market
--   from (
--     select distinct r.round_id, r.client_id, coalesce(a.campaign, '') as campaign
--       from ads_performance a join rounds r on r.round_id = a.round_id
--     union
--     select distinct r.round_id, r.client_id, coalesce(e.utm_campaign, '') as campaign
--       from events e join rounds r on r.round_id = e.round_id
--   ) p
--   join v_campaign_dimensions d
--     on d.client_id = p.client_id and coalesce(d.campaign, '') = p.campaign
--   where d.market is not null;
--
-- The number I want is how many times `fo_resolve` is executed, which shows up
-- as the loop count on the node containing v_campaign_dimensions. If it is 52,
-- the rules are not the problem and I have been wrong about the cause four
-- times. If it is in the thousands, the view is being inlined and re-evaluated
-- per outer row, and the fix is to force it to materialise once — which is a
-- different repair from any of the three already tried.
