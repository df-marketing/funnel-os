-- THE COUNTRY FILTER IS FIXED, AND THE NUMBER I WAS CHECKING IT AGAINST WAS
-- NEVER REAL.
--
-- This migration changes no schema. It records a correction, because five
-- delivered files tell the next reader to expect a figure that does not exist,
-- and a wrong expectation is worse than no expectation — it makes a correct
-- result look like a failure.
--
-- ── WHAT THE FILTER ACTUALLY RETURNS ───────────────────────────────────────
--
--     country=MY       1 round   ·    989.53 · 247 leads   0926-01
--     country=SG      12 rounds  · 19,485.25 · 1,601 leads
--     country=SG,MY   12 rounds  · 20,474.78 · 1,848 leads
--
--     989.53 + 19,485.25 = 20,474.78, exactly the account total.
--
-- This is correct. There are exactly two MY campaigns in the account —
-- DF_MY_Preview_Sprint1_0926_01_LP1GHL and _LP2GHL — and both ran in 0926-01.
-- One round is the true answer. Every other Shely round is Singapore, eleven of
-- them declaring `country = 'SG'` on the row and the twelfth, 0926-01, admitted
-- by its SG campaigns. A round can be in both, which is why 0926-01 appears in
-- each list and why the two lists do not sum to thirteen.
--
-- The 41 leads between 1,848 and the unfiltered 1,889 sit on campaigns that
-- resolve to no market at all — "ALL CAMPAIGNS 0526-02", "{{campaign.name}}"
-- and fourteen others. They are counted in the round and not in a country,
-- which is the rule working, not a leak.
--
-- ── WHERE "4" CAME FROM ────────────────────────────────────────────────────
--
-- Nowhere. Early in this investigation the country queries were returning
--
--     {"code": "57014", "message": "canceling statement due to statement
--      timeout", "details": null, "hint": null}
--
-- and the script counting the response counted the keys of that error object.
-- Four keys became "4 rounds", I wrote it into the verification notes of
-- migration 29, and it was copied forward into 30, 31, 35 and 36 without ever
-- being checked against the data. Five files now say a correct result is wrong.
--
-- That is the whole reason it matters: the next person to run these files reads
-- "expect 4", sees 1, and reverts a working fix.
--
-- ── WHAT IS STILL BROKEN ───────────────────────────────────────────────────
--
-- Not the country filter. `v_journey_strip` — the six boxes across the top of
-- every screen — times out with or without a country selected, which is what
-- the error on screen has been saying:
--
--     v_journey        0.27s      the stages themselves
--     v_metrics_total  0.51s      the numbers it reads
--     v_journey_strip  2.36s      the two joined, plus per-row functions
--     through fo_cut   TIMEOUT
--
-- 0.27 + 0.51 is 0.78. The other 1.6 seconds is in the functions the view calls
-- per row — fo_stage_extras, fo_add_stage_costs, fo_source_blind — and eleven
-- rows at roughly 145ms each accounts for it exactly.
--
-- That is the same shape as the fault 35 fixed: something that should be
-- evaluated once per client is being evaluated once per row. It is NOT being
-- repaired here on the strength of that resemblance. The plan gets read first —
-- the query is in file 37 — because reasoning from resemblance is what produced
-- migrations 29 through 33.

-- Nothing to run. The corrections below replace the expectations printed in the
-- verification sections of 29, 30, 31, 35 and 36.

comment on view v_round_markets is
  'The markets each round has evidence of having run in, from its ad rows and '
  'its people. Shely: MY on 0926-01 only, SG on all twelve. A round can be in '
  'both. Reads v_campaign_dimensions, whose MATERIALIZED fence is what keeps '
  'fo_resolve at 104 calls instead of 4,890.';

comment on view v_rounds is
  'Rounds surviving the product, country and date filters. The country is the '
  'round''s own when it declares one that was chosen, otherwise a chosen market '
  'it has evidence of running in, otherwise NULL — which fails the filter, '
  'correctly, because the round ran in none of them. The markets are looked up '
  'once per query, not once per round.';

-- ── THE CORRECTED EXPECTATIONS ─────────────────────────────────────────────
--
--   select * from fo_cut('v_metrics_by_round', 'shely', p_country => 'MY');
--     1 round · 0926-01 · 989.53 · 247 leads
--
--   select * from fo_cut('v_metrics_by_round', 'shely', p_country => 'SG');
--     12 rounds · 19,485.25 · 1,601 leads
--
--   select * from fo_cut('v_metrics_by_round', 'shely', p_country => 'SG,MY');
--     12 rounds · 20,474.78 · 1,848 leads
--
--   unfiltered
--     13 rounds · 20,474.78 · 1,889 leads · 682 attendance · 83,927.00 revenue
--
-- A filter is a set, and the set check still holds: choosing both returns at
-- least as many rounds as choosing either. Twelve and one giving twelve is that
-- rule satisfied, because the one is inside the twelve.
