-- 31'S CHANGE, RE-APPLIED NOW THAT ITS PRECONDITION IS TRUE.
--
-- 35 fixed the root cause. Measured over three runs each:
--
--                          before 35    after 35
--     v_round_markets         1.99s      0.12–0.17s
--     v_client_countries      2.75s      0.14s
--     v_campaign_dimensions   0.14s      0.14–0.22s   unchanged
--     v_ads                   0.24s      0.30s        unchanged
--     by_round, no country    1.19s      1.15–1.49s   unchanged
--
-- The country filter still times out, and the reason is the second cost named
-- in 31 and never fixed: `fo_round_country_pick` is called once per round from
-- `v_rounds`, and every call re-runs the whole markets lookup. Thirteen rounds
-- at 0.13s is 1.7 seconds on top of a 1.3 second base.
--
-- A correlated function call cannot be hoisted. An uncorrelated subquery in the
-- FROM clause is evaluated once, so that is what this makes it.
--
-- ── WHY THIS IS SAFE NOW AND WAS NOT IN 31 ─────────────────────────────────
--
-- This is the same change 31 made, and 31 took the app down. It is worth being
-- precise about what is different rather than hoping.
--
-- The cost is paid even when no country is chosen: the planner cannot skip a
-- join on the strength of a runtime setting. In 31 that meant every screen paid
-- 2.4 seconds for a lookup most of them never used, and v_rounds went from
-- 0.18s to 1.89s, taking down pages that had nothing to do with countries.
--
-- I wrote then that paying always would be an honest trade "once the lookup is
-- cheap". It was not cheap and I shipped it anyway. It is now 0.13s, so the
-- same sentence is finally true — and the number, not the sentence, is what
-- makes it true.
--
-- Expected: v_rounds 0.06s → about 0.2s, by_round 1.3s → about 1.5s. If either
-- is materially worse than that, this is wrong again and the revert is file 32.

begin;

create or replace view v_rounds as
select r.*
from rounds r
/* Uncorrelated, so it is built once per query rather than once per round.
   Filtering inside the subquery rather than after it means that when no
   country is chosen, `market = any(null)` is null, no row qualifies, and the
   aggregate has nothing to group. */
left join (
  select round_id, min(market) as pick
  from v_round_markets
  where market = any(fo_country_selection())
  group by round_id
) picks on picks.round_id = r.round_id
where fo_filter_people_ok(
        r.product_id,
        case
          -- Nothing chosen: the country is not consulted at all.
          when fo_country_selection() is null then r.country
          -- The round declares a country and it was chosen.
          when r.country = any(fo_country_selection()) then r.country
          -- Otherwise a chosen market this round genuinely ran in, or NULL when
          -- it ran in none — which correctly fails the predicate. `min` is a
          -- deterministic choice among several; any single match admits the
          -- round, and v_ads and v_events then narrow what is counted INSIDE
          -- it, per row.
          else picks.pick
        end,
        r.start_date, r.end_date
      );

grant select on v_rounds to anon, authenticated;

commit;

-- ── VERIFY — SPEED FIRST HERE, BECAUSE SPEED IS WHAT THIS RISKS ────────────
--
-- 1. THE UNFILTERED PATH DID NOT REGRESS. This is the check 31 failed and the
--    reason it broke the app. Run it BEFORE celebrating the filter:
--
--      v_rounds, no filter      was 0.06s   expect under 0.25s
--      by_round, no country     was 1.3s    expect under 1.6s
--      fo_cut total             was 1.6s    expect under 1.9s
--
--    Materially worse than that and this migration is wrong. File 32 is the
--    revert and it restores a working app in one statement.
--
-- 2. THE FILTER ANSWERS AT ALL:
--
--      country=MY     4 rounds
--      country=SG    12 rounds
--      country=SG,MY 13 rounds
--
--    A filter is a set. Choosing both must never return fewer than choosing
--    one — that is the specific bug this path has shipped before.
--
--    Note v_round_markets has evidence of MY on 0926-01 only. MY returning 4
--    rather than 1 is correct: the other three declare `country` on the round
--    and are admitted by the second CASE branch. If MY returns 1, that branch
--    is broken.
--
-- 3. THE TOTALS, unmoved:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
--    And the four MY rounds must be the SAME four as before, not merely four.
--    A total that does not move is not proof.
