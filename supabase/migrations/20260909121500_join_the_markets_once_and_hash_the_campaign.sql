-- TWO COSTS, AND 30 ONLY REMOVED ONE OF THEM.
--
-- After migration 30 the view answers instead of timing out, and the filter
-- still times out. Measured:
--
--     dimension_values            10 rows
--     v_campaign_dimensions       52 rows      0.24s
--     ads_performance          1,855 rows
--     events                   3,035 rows
--     v_round_markets             13 rows      2.36s   ← still ten times slower
--                                                        than the thing it reads
--
-- A view that returns thirteen rows from a fifty-two row lookup has no business
-- taking two seconds. There are two separate faults left.
--
-- ── FAULT ONE — the rules run per PAIR, not per campaign ───────────────────
--
-- 30 collapsed to distinct (round, client, campaign) and then called
-- `fo_resolve` on that — but a campaign appears under several rounds, so the
-- same campaign is resolved once per round it ran in, and the WHERE clause
-- calls it a second time on every row. Roughly four hundred calls to do fifty-
-- two campaigns' worth of work.
--
-- `v_campaign_dimensions` already holds the answer, already deduplicated, in
-- 0.24s. The reason 30 did not use it was the join predicate — `IS NOT DISTINCT
-- FROM` cannot be hashed, which is what started all of this. But that predicate
-- exists only because `campaign` is nullable, and `coalesce(x, '')` on both
-- sides is null-safe AND hashable. A fifty-two row hash table, and both big
-- tables streamed through it once.
--
-- ── FAULT TWO — v_rounds asks per round ────────────────────────────────────
--
-- `fo_round_country_pick` is called once per round from `v_rounds`, and each
-- call re-runs the whole lookup. Even at a tenth of a second that is thirteen
-- tenths before anything else happens, and every metric view joins v_rounds.
--
-- A correlated function call cannot be hoisted. An uncorrelated subquery in the
-- FROM clause is evaluated once, so that is what this becomes. The cost is paid
-- even when no country is chosen — the planner cannot skip a join on the
-- strength of a runtime setting — which is why fault one had to be fixed first.
-- Once the lookup is cheap, paying for it always is the honest trade.
--
-- The rule is unchanged for the fourth time: A ROUND IS IN A COUNTRY IF IT RAN
-- THERE, NOT IF IT DECLARED ONE.

begin;

/**
 * The chosen countries as an array, or NULL when nothing is chosen.
 *
 * Written out four times across these functions before now, which is four
 * places for the empty-string case to be handled differently. NULL means "no
 * country filter", and an empty selection has to mean the same thing — a filter
 * nobody set cannot exclude anything.
 */
create or replace function fo_country_selection()
returns text[]
language sql
stable
as $$
  select nullif(
    string_to_array(nullif(current_setting('funnel.country', true), ''), ','),
    '{}'
  );
$$;

grant execute on function fo_country_selection() to anon, authenticated;

/**
 * The markets each round has evidence of having run in.
 *
 * Reads the campaign lookup rather than re-deriving it: fifty-two rows, hashed
 * once, with both big tables streamed through it. `coalesce(campaign, '')` on
 * both sides is what makes that possible — it is null-safe like IS NOT DISTINCT
 * FROM and, unlike it, hashable.
 *
 * A round appears once per market it can vouch for, and not at all when it can
 * vouch for none. A round that bought no traffic and drew nobody ran nowhere.
 */
create or replace view v_round_markets as
select distinct p.round_id, d.market
from (
  select distinct r.round_id, r.client_id, coalesce(a.campaign, '') as campaign
    from ads_performance a
    join rounds r on r.round_id = a.round_id
  union
  select distinct r.round_id, r.client_id, coalesce(e.utm_campaign, '') as campaign
    from events e
    join rounds r on r.round_id = e.round_id
) p
join v_campaign_dimensions d
  on d.client_id = p.client_id
 and coalesce(d.campaign, '') = p.campaign
where d.market is not null;

grant select on v_round_markets to anon, authenticated;

comment on view v_round_markets is
  'The markets each round has evidence of having run in. Reads '
  'v_campaign_dimensions rather than re-resolving the rules per round, and '
  'joins on coalesce(campaign, '''') because IS NOT DISTINCT FROM cannot be '
  'hashed. Read once per query by v_rounds.';

/**
 * Kept, and no longer on the hot path.
 *
 * 0071 promised nothing would be dropped, so nothing that calls this needs
 * touching. It is now the readable statement of the rule rather than the thing
 * that executes it thirteen times.
 */
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

/**
 * The same three cases in the same order, asked once for every round at once.
 *
 * `picks` is uncorrelated, so it is built a single time per query instead of
 * once per round. `min(market)` is a deterministic choice among several
 * qualifying markets, matching the ORDER BY above — any single match admits the
 * round, and v_ads and v_events then narrow what is counted INSIDE it, per row.
 */
create or replace view v_rounds as
select r.*
from rounds r
left join (
  select round_id,
         min(market) filter (where market = any(fo_country_selection())) as pick
  from v_round_markets
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
          -- it ran in none of them — which correctly fails the predicate.
          else picks.pick
        end,
        r.start_date, r.end_date
      );

grant select on v_rounds to anon, authenticated;

commit;

-- ── VERIFY, through the anon key and never this editor ─────────────────────
--
-- 1. THE FILTER ANSWERS, which is the whole point:
--
--      country=MY    →   4 rounds
--      country=SG    →  12 rounds
--      country=SG,MY →  13 rounds
--
--    A filter is a set: both must never return fewer than one. Note the
--    markets view says MY has evidence on only 0926-01 — if MY returns 1 round
--    rather than 4, the rounds carrying a declared `country` are being dropped
--    and the first CASE branch is wrong.
--
-- 2. THE UNFILTERED TOTAL, unmoved:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
--    And the four MY rounds must be the SAME four as before, not merely four.
--    A total that does not move is not proof.
--
-- 3. NOTHING ELSE GOT SLOWER. v_rounds now pays for the markets join even with
--    no country chosen. It was 0.18s and fo_cut by_round was 1.19s; if either
--    has grown by more than a couple of tenths, say so rather than accepting it.
