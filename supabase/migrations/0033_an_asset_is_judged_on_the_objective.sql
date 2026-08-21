-- ═══════════════════════════════════════════════════════════════════════════
-- 0033 — what each audience and creative actually PRODUCED, not just collected.
--
-- This round has an OBJECTIVE picker with four settings, and until now it moved
-- one section of the screen. Step 7 proposed candidates on cost per lead
-- whatever you picked, which is the wrong question when the client's objective
-- is attendance: an audience can be the cheapest source of leads on the account
-- and the worst source of people who actually turn up.
--
-- Step 7 could not ask any other question, because v_round_assets carries spend
-- and leads and nothing else. This appends the three outcomes the other
-- objectives are judged on.
--
-- ── WHY IT HAS TO GO THROUGH THE LEAD ──────────────────────────────────────
-- An attendance row has no ad_set on it and neither does a sale — only leads
-- carry the audience and creative, because only the opt-in passed through a URL
-- with utm_term on it. So the outcome is attributed the way revenue already is
-- (see 0020): find the person's LEAD, and credit the asset that bought it.
--
-- On this database that resolves 37 of 40 attendances and 19 of 19 sales. The
-- three that don't are the three whose lead row is sitting in the unmatched
-- queue — they are missing from these counts for exactly the reason the queue
-- exists, and they are not invented here.
--
-- ── WHY lead_round_id AND NOT round_id ─────────────────────────────────────
-- A buyer can attend one round and buy in the next. round_id says where the
-- event happened; lead_round_id says which round's advertising produced the
-- person. The asset lives in the second one, and joining on it rather than on
-- contact alone is also what stops a returning contact's second lead row from
-- multiplying their attendance across two rounds.
--
-- ── WHAT THIS DOES NOT CHANGE ──────────────────────────────────────────────
-- Nothing that already reads this view moves. `spend`, `leads`, `spend_share`
-- and `id_count` are byte-for-byte what they were; the three new columns are
-- APPENDED, which is the only edit `create or replace view` permits.
--
-- And it makes no claim about whether the counts are big enough to rank on.
-- They mostly are not — in 0526-03 the best audience produced three attendees
-- and every preview purchase is untagged — so the screen reports the floor it
-- could not clear instead of ranking on threes. That is the point of measuring
-- it: you can now see that the data cannot answer the question, rather than
-- being shown a cost-per-lead answer to a question about attendance.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_round_assets as
with named as (
  select r.client_id, a.round_id, 'audience'::text as kind,
         coalesce(nullif(btrim(a.ad_set), ''), '(unsplit)') as name,
         sum(a.spend) as spend,
         0::int as ids
  from v_ads a join v_rounds r on r.round_id = a.round_id
  group by 1, 2, 3, 4
  union all
  select r.client_id, a.round_id, 'creative',
         case when btrim(a.ad) ~ '^[0-9]+$' then '(ad ids)'
              else coalesce(nullif(btrim(a.ad), ''), '(unsplit)') end,
         sum(a.spend),
         count(distinct a.ad) filter (where btrim(a.ad) ~ '^[0-9]+$')::int
  from v_ads a join v_rounds r on r.round_id = a.round_id
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
  from v_events e
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
  from v_events e join v_rounds r on r.round_id = e.round_id
  where e.event_type = 'lead'
  group by 1, 2, 3, 4
  union all
  select r.client_id, e.round_id, 'creative',
         case when btrim(e.ad) ~ '^[0-9]+$' then '(ad ids)'
              else coalesce(nullif(btrim(e.ad), ''), '(unsplit)') end,
         count(*),
         count(distinct e.ad) filter (where btrim(e.ad) ~ '^[0-9]+$')::int
  from v_events e join v_rounds r on r.round_id = e.round_id
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
  from v_events e
  join v_rounds r on r.round_id = e.lead_round_id
  join lead_asset la on la.contact_id = e.contact_id and la.round_id = e.lead_round_id
  where e.event_type in ('attendance', 'sale')
  group by 1, 2, 3, 4
  union all
  select r.client_id, e.lead_round_id, 'creative', la.creative,
         count(*) filter (where e.event_type = 'attendance'),
         count(*) filter (where e.event_type = 'sale' and e.product = 'preview'),
         coalesce(sum(coalesce(e.amount, 0) - coalesce(e.refund_amount, 0))
                  filter (where e.event_type = 'sale'), 0)
  from v_events e
  join v_rounds r on r.round_id = e.lead_round_id
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
