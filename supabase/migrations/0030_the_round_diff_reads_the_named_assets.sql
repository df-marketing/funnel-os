-- ═══════════════════════════════════════════════════════════════════════════
-- 0030 — step 3 was reporting twelve changes that are one tracking fault.
--
-- The first look at "This round" against real data showed this under "what
-- changed upstream":
--
--     added    120248589768770425   new this round · 1 lead
--     added    120248589768820425   new this round · 1 lead
--     added    120249100531290425   new this round · 2 leads
--     … nine of them, then three more dropped …
--     reweighted  Static_ContentAtScale_StructuredText  88.5% → 35.4%
--
-- Every one of those numbers is an untracked ad. A second GoHighLevel tracking
-- template writes {{ad.id}} where the others write the ad's name, so those
-- leads carry an ID that appears in no Meta export — which is why they have no
-- spend, and why they look "new" in any round where a different set of them
-- happened to fire. 0021 already collapsed them into one column on the Ads tab
-- for exactly this reason; v_round_assets was written afterwards and read the
-- raw column, so the same fault came back on a different screen.
--
-- Twelve lines of noise pushed the one real change — an audience going from 88%
-- of the round's spend to 35% — to the bottom of the list. A diff that reports
-- everything reports nothing.
--
-- They are bucketed, not dropped: those leads are real people, and '(ad ids)'
-- appearing or disappearing is still a fact about the round. It is now one line
-- carrying its own count instead of nine lines carrying one lead each.
--
-- Changes no metric. This view feeds one screen and no total.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_round_assets as
with named as (
  -- One name for every creative whose utm_content was an ID rather than a name.
  -- Same test as 0021: all digits, nothing else.
  select r.client_id, a.round_id, 'audience'::text as kind,
         coalesce(nullif(btrim(a.ad_set), ''), '(unsplit)') as name,
         sum(a.spend) as spend, 0 as ids
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
got as (
  select r.client_id, e.round_id, 'audience'::text as kind,
         coalesce(nullif(btrim(e.ad_set), ''), '(unsplit)') as name,
         count(*) as leads, 0 as ids
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
  nullif(ids, 0) as id_count
from joined
order by client_id, round_id, kind, spend desc nulls last, name;

grant select on v_round_assets to anon, authenticated;
