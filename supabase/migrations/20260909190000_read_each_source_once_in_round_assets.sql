-- v_round_assets READS THE SAME THREE VIEWS ELEVEN TIMES.
--
-- "This round" is the last broken screen. It fails on v_round_assets, which
-- takes 16.7 seconds on its own while every other query in the app is now under
-- 1.5.
--
-- This is not a guess about the planner. Count the FROM clauses in the shipped
-- definition:
--
--     v_rounds   6 times   named x2, got x2, produced x2
--     v_events   5 times   lead_asset, got x2, produced x2
--     v_ads      2 times   named x2
--
-- Each of those is a view, and none of them is cheap. v_events joins events to
-- rounds and to v_campaign_dimensions and applies the session filters; v_rounds
-- has carried the markets lookup since migration 36; v_ads does the campaign
-- join too. Reading them once each instead of eleven times is the whole change.
--
-- ── WHAT IS NOT CHANGING ───────────────────────────────────────────────────
--
-- Every CTE below computes exactly what it computed before, from exactly the
-- same rows. `joined`, `with_outcomes` and the final SELECT are untouched,
-- character for character — 0030 and 0033 both left notes saying that the safe
-- way to work on this view is to leave the existing columns alone, and that
-- still holds. The only edit is WHERE each CTE reads from.
--
--     named      v_ads    -> ads_cut
--     lead_asset v_events -> events_cut
--     got        v_events -> events_cut,  v_rounds -> rounds_cut
--     produced   v_events -> events_cut,  v_rounds -> rounds_cut
--
-- The event-type filters move from each CTE's WHERE into the same WHERE on the
-- shared read, so the same rows arrive in the same places.
--
-- ── THE ONE COST THIS ADDS ─────────────────────────────────────────────────
--
-- MATERIALIZED is a fence, so the outer `client_id = 'shely'` cannot push into
-- the three reads and they compute for every client. With two clients that is a
-- clear win against eleven evaluations. With twenty it would not be, and the
-- honest fix then is a client parameter rather than a view — worth knowing
-- before the next client lands rather than after.

begin;

create or replace view v_round_assets as
with rounds_cut as materialized (
  select round_id, client_id from v_rounds
),
ads_cut as materialized (
  select round_id, ad_set, ad, spend from v_ads
),
/* One read of v_events for all three uses. The three event types this view
   cares about are taken together and separated by the CTEs below, so the
   expensive part — the joins and filters inside v_events — happens once. */
events_cut as materialized (
  select contact_id, round_id, lead_round_id, event_type, event_date,
         product, ad_set, ad, amount, refund_amount
  from v_events
  where event_type in ('lead', 'attendance', 'sale')
),
named as (
  select r.client_id, a.round_id, 'audience'::text as kind,
         coalesce(nullif(btrim(a.ad_set), ''), '(unsplit)') as name,
         sum(a.spend) as spend,
         0::int as ids
  from ads_cut a join rounds_cut r on r.round_id = a.round_id
  group by 1, 2, 3, 4
  union all
  select r.client_id, a.round_id, 'creative',
         case when btrim(a.ad) ~ '^[0-9]+$' then '(ad ids)'
              else coalesce(nullif(btrim(a.ad), ''), '(unsplit)') end,
         sum(a.spend),
         count(distinct a.ad) filter (where btrim(a.ad) ~ '^[0-9]+$')::int
  from ads_cut a join rounds_cut r on r.round_id = a.round_id
  group by 1, 2, 3, 4
),
/**
 * One row per person per round, carrying the asset that produced them.
 *
 * distinct on, because the lead dedupe key is (contact, round, DAY) — one
 * person can hold two lead rows in a round and joining on contact alone would
 * count their single attendance twice. The earliest opt-in wins: it is the one
 * that bought them.
 */
lead_asset as (
  select distinct on (e.contact_id, e.round_id)
         e.contact_id,
         e.round_id,
         coalesce(nullif(btrim(e.ad_set), ''), '(unsplit)') as audience,
         case when btrim(e.ad) ~ '^[0-9]+$' then '(ad ids)'
              else coalesce(nullif(btrim(e.ad), ''), '(unsplit)') end as creative
  from events_cut e
  where e.event_type = 'lead'
  order by e.contact_id, e.round_id, e.event_date
),
/**
 * Leads per asset, and the untracked-ad count — LIFTED FROM 0030 UNCHANGED.
 *
 * Deliberately not folded into the outcome union below. `leads` and `id_count`
 * are columns the screen already reads, and the only safe way to append to a
 * view is to leave the existing columns computing exactly what they computed
 * before. Rewriting them to produce the same answer is a bet; not touching them
 * is not.
 */
got as (
  select r.client_id, e.round_id, 'audience'::text as kind,
         coalesce(nullif(btrim(e.ad_set), ''), '(unsplit)') as name,
         count(*) as leads,
         0::int as ids
  from events_cut e join rounds_cut r on r.round_id = e.round_id
  where e.event_type = 'lead'
  group by 1, 2, 3, 4
  union all
  select r.client_id, e.round_id, 'creative',
         case when btrim(e.ad) ~ '^[0-9]+$' then '(ad ids)'
              else coalesce(nullif(btrim(e.ad), ''), '(unsplit)') end,
         count(*),
         count(distinct e.ad) filter (where btrim(e.ad) ~ '^[0-9]+$')::int
  from events_cut e join rounds_cut r on r.round_id = e.round_id
  where e.event_type = 'lead'
  group by 1, 2, 3, 4
),
/**
 * The three new outcomes, attributed through the person's lead row.
 *
 * An attendance or sale whose lead is parked has no asset to credit and drops
 * out here — the same understatement the unmatched queue already reports, in
 * the same direction. Nothing is invented to fill the gap.
 */
produced as (
  select r.client_id, e.lead_round_id as round_id, 'audience'::text as kind,
         la.audience as name,
         count(*) filter (where e.event_type = 'attendance') as att,
         count(*) filter (where e.event_type = 'sale' and e.product = 'preview') as prev_buys,
         coalesce(sum(coalesce(e.amount, 0) - coalesce(e.refund_amount, 0))
                  filter (where e.event_type = 'sale'), 0) as rev
  from events_cut e
  join rounds_cut r on r.round_id = e.lead_round_id
  join lead_asset la on la.contact_id = e.contact_id and la.round_id = e.lead_round_id
  where e.event_type in ('attendance', 'sale')
  group by 1, 2, 3, 4
  union all
  select r.client_id, e.lead_round_id, 'creative', la.creative,
         count(*) filter (where e.event_type = 'attendance'),
         count(*) filter (where e.event_type = 'sale' and e.product = 'preview'),
         coalesce(sum(coalesce(e.amount, 0) - coalesce(e.refund_amount, 0))
                  filter (where e.event_type = 'sale'), 0)
  from events_cut e
  join rounds_cut r on r.round_id = e.lead_round_id
  join lead_asset la on la.contact_id = e.contact_id and la.round_id = e.lead_round_id
  where e.event_type in ('attendance', 'sale')
  group by 1, 2, 3, 4
),
joined as (
  select
    coalesce(s.client_id, g.client_id) as client_id,
    coalesce(s.round_id,  g.round_id)  as round_id,
    coalesce(s.kind,      g.kind)      as kind,
    coalesce(s.name,      g.name)      as name,
    s.spend,
    g.leads,
    greatest(coalesce(s.ids, 0), coalesce(g.ids, 0)) as ids
  from named s
  full outer join got g
    on  g.client_id = s.client_id and g.round_id = s.round_id
    and g.kind = s.kind           and g.name    = s.name
),
-- A separate pass rather than a third arm of the join above, so `joined` stays
-- character-for-character what 0030 produced.
with_outcomes as (
  select j.*, p.att, p.prev_buys, p.rev
  from joined j
  left join produced p
    on  p.client_id = j.client_id and p.round_id = j.round_id
    and p.kind      = j.kind      and p.name     = j.name
)
select
  client_id, round_id, kind, name,
  spend,
  coalesce(leads, 0)::int as leads,
  round(
    100 * spend / nullif(sum(spend) over (partition by client_id, round_id, kind), 0),
    1
  ) as spend_share,
  -- how many untracked ads the '(ad ids)' row stands for, so the screen can say
  -- so rather than presenting a bucket as if it were one creative
  nullif(ids, 0) as id_count,
  -- ── APPENDED BY 0033 ───────────────────────────────────────────────────
  -- Zero here is a measurement, not an absence: the asset is in this round — it
  -- has spend, or it has leads — and produced none of these. That is precisely
  -- the case step 7 exists to surface, so it must not read as null.
  --
  -- The one case where a zero would LIE is a round where attendance was never
  -- imported at all, which would make every audience look like it produced
  -- nobody. That is caught where it can be judged, in candidatesFrom(): an
  -- asset is never blamed for a nought the whole round shares.
  coalesce(att, 0)::int       as att,
  coalesce(prev_buys, 0)::int as prev_buys,
  coalesce(rev, 0)::numeric   as rev
from with_outcomes
order by client_id, round_id, kind, spend desc nulls last, name;

grant select on v_round_assets to anon, authenticated;

commit;

-- ── VERIFY — NUMBERS FIRST ─────────────────────────────────────────────────
--
-- 1. THE SAME ROWS. This is a de-duplication of reads, so every figure must be
--    identical. Spend per round still adds to the account total:
--
--      select round_id, kind, sum(spend)
--        from v_round_assets where client_id = 'shely' and kind = 'audience'
--       group by 1, 2 order by 1;
--
--      select sum(spend) from v_round_assets
--       where client_id = 'shely' and kind = 'audience';
--        -- 20,474.78
--
--      select sum(leads) from v_round_assets
--       where client_id = 'shely' and kind = 'audience';
--        -- 1,889
--
--    Audience and creative are two views of the same spend, so each kind sums
--    to the total on its own. If they disagree, this rewrite is wrong.
--
-- 2. THE SCREEN. Open This round. It was the only page still failing.
--
-- 3. THE APP TOTALS, unmoved:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
-- 4. SPEED. Was 16.7s. Reading three views once instead of eleven times should
--    put it near the sum of their individual costs — v_events about 1.5s, v_ads
--    0.3s, v_rounds 0.2s — so a few seconds, not sixteen. If it is still over
--    ten, the repetition was not the whole cost and the next step is a plan,
--    not another rewrite.
