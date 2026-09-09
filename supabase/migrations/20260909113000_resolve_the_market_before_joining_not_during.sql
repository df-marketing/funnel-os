-- THE JOIN IS THE COST, NOT THE NUMBER OF TIMES IT RUNS.
--
-- Migration 20260909104500 moved the round→market lookup into a view so the
-- rules would resolve once per read instead of once per round. It did not help:
-- the country filter still times out, and `select * from v_round_markets` times
-- out on its own. Measured:
--
--     v_campaign_dimensions          0.07s
--     v_rounds, nothing selected     0.18s
--     fo_cut by_source, country=MY   0.58s   ← country filtering is fine here
--     fo_cut by_round, no country    1.19s
--     v_round_markets                TIMEOUT
--
-- So the fault was never how many times the lookup ran. It is the lookup.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
--     join v_campaign_dimensions d on d.campaign is not distinct from a.campaign
--
-- `IS NOT DISTINCT FROM` is null-safe equality, and Postgres cannot hash or
-- merge on it. The planner has one option left — a nested loop — and the thing
-- on the inside of that loop is `v_campaign_dimensions`, which is not a table:
-- it is a DISTINCT over ads_performance joined to rounds, UNIONed with a
-- DISTINCT over events joined to rounds, with `fo_resolve` run over every
-- campaign it finds.
--
-- So the rules engine runs again for every row on the outside of the join —
-- roughly 1,800 ad rows and 2,700 events — and that is the three seconds. This
-- predicate is in the shipped code in six places; it came in with the drop of
-- the retired columns, which is when the country path stopped being a column
-- read and became a join.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- Do not join campaigns to their resolved market. COLLAPSE FIRST, RESOLVE
-- AFTER. Distinct (round, client, campaign) over both tables is a hundred-odd
-- rows; `fo_resolve` then runs a hundred-odd times, once, with no join and no
-- null-safe predicate anywhere.
--
-- The rule is unchanged for the third time and stays unchanged: A ROUND IS IN A
-- COUNTRY IF IT RAN THERE, NOT IF IT DECLARED ONE.

begin;

/**
 * The markets each round has evidence of having run in.
 *
 * The campaigns are collapsed to their distinct values BEFORE the rules are
 * applied, rather than the rules being applied to every row and the results
 * then joined back. Same answer, and the difference between a hundred calls and
 * four thousand inside a nested loop.
 *
 * A round appears once per market it can vouch for and not at all when it can
 * vouch for none — a round that bought no traffic and drew nobody ran nowhere,
 * which is the answer the original gave and the one the two demo rounds need.
 */
create or replace view v_round_markets as
select distinct c.round_id, fo_resolve(c.client_id, 'market', c.campaign) as market
from (
  select distinct r.round_id, r.client_id, a.campaign
    from ads_performance a
    join rounds r on r.round_id = a.round_id
  union
  select distinct r.round_id, r.client_id, e.utm_campaign as campaign
    from events e
    join rounds r on r.round_id = e.round_id
) c
where fo_resolve(c.client_id, 'market', c.campaign) is not null;

grant select on v_round_markets to anon, authenticated;

comment on view v_round_markets is
  'The markets each round has evidence of having run in, from its ad rows and '
  'its people. Campaigns are collapsed to distinct values before the rules are '
  'applied — joining resolved markets back onto rows needs IS NOT DISTINCT '
  'FROM, which Postgres can only nested-loop, and the inside of that loop '
  'reruns the rules engine. Read by fo_round_country_pick.';

commit;

-- ── VERIFY, in this order ──────────────────────────────────────────────────
--
-- 1. THE VIEW ANSWERS AT ALL. This is the one that was timing out:
--
--      select round_id, market from v_round_markets order by market, round_id;
--
--    Expect Shely's thirteen rounds spread over MY and SG, and NEITHER demo
--    round — DEMO-MY-0526-01 carries market 'MY' but has no ad rows and no
--    people, so it ran nowhere. `market` on the round is the naming scope that
--    lets MY and SG share the code 0526-01; this view is where a round is
--    evidenced to have run. Two different questions, kept different.
--
-- 2. THE FILTER, through the anon key and not this editor:
--
--      country=MY    →   4 rounds
--      country=SG    →  12 rounds
--      country=SG,MY →  13 rounds
--
--    A filter is a set. Choosing both must never return fewer than choosing
--    one, and that is the check this specific bug has failed before.
--
-- 3. THE UNFILTERED TOTAL, unmoved:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
--    And check the four MY rounds are the SAME four as before, not merely that
--    there are four. A total that does not move is not proof.
