-- ═══════════════════════════════════════════════════════════════════════════
-- 0029 — the three things "This round" needs and cannot currently ask for.
--
-- The CRO process compares a round against the previous one, against the month
-- to date, and against a TARGET, then asks what changed upstream to explain any
-- metric that moved. Two of those three the app can already answer. This adds
-- the missing pieces, and adds nothing else — no metric changes here.
--
-- ── 1. HOW FAR THROUGH THE ROUND IS ────────────────────────────────────────
-- v_metrics_this_round carries start_date and not end_date, so the screen can
-- say which round is running and not whether it is on day 2 or day 12. "CPL is
-- 7.83" means something different on each, and a round two days old should not
-- be judged at all. end_date is appended — `create or replace view` may add
-- columns at the end and may not insert them.
--
-- ── 2. A TARGET TO COMPARE AGAINST ─────────────────────────────────────────
-- "Comparisons are against previous months/rounds/weeks & target." There is no
-- target anywhere in this database, and there never has been — the project note
-- has said "no objective is set" since the first sprint. So the table is
-- created EMPTY. Not seeded with a guess, not defaulted to last round's number:
-- a target nobody set is not a target, and a screen that invents one teaches
-- people to trust invented numbers.
--
-- Until a row exists the screen says which metrics have no target and compares
-- against the previous round and the all-round baseline instead, saying so.
-- Setting one is a single INSERT, the same way unit prices are set.
--
-- ── 3. WHAT CHANGED UPSTREAM ───────────────────────────────────────────────
-- Step 3 of the process asks, when a rate falls: was there a new ad, did the
-- budget split move, did targeting change. All three are answerable from what
-- is already imported — they are questions about which audiences and creatives
-- carried money in this round versus the one before. v_round_assets puts one
-- row per round per asset so the two rounds can be diffed.
--
-- It deliberately does NOT answer "did the landing page change". No
-- landing-page dimension exists (the LP tab has been parked for that reason
-- since 0015), and Clarity data covers no round in this database. That question
-- stays unanswered and the screen says so rather than quietly dropping it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. END DATE ────────────────────────────────────────────────────────────
create or replace view v_metrics_this_round as
select
  client_id, cut_key, cut_label, cut_sub, start_date, m,
  case when rn = 1 then 'this round' else 'previous' end as period,
  rn::int as ord,
  end_date
from (
  select b.*, r.end_date,
         row_number() over (partition by b.client_id order by b.start_date desc) as rn
  from v_metrics_by_round b
  join v_rounds r on r.round_id = b.cut_key
  where r.start_date <= current_date
) ranked
where rn <= 2
order by client_id, start_date;

grant select on v_metrics_this_round to anon, authenticated;

-- ── 2. TARGETS ─────────────────────────────────────────────────────────────
-- One row per metric a client has actually agreed a number for. `metric` is a
-- spine key ('cpl', 'attPct', 'roas', …) so the screen can look a target up by
-- the same name it renders the row under.
create table if not exists client_targets (
  client_id text    not null,
  metric    text    not null,
  target    numeric not null,
  note      text,                       -- who set it and when, in words
  primary key (client_id, metric)
);

alter table client_targets enable row level security;
drop policy if exists "demo read" on client_targets;
create policy "demo read" on client_targets for select using (true);
grant select on client_targets to anon, authenticated;

create or replace view v_client_targets as
select client_id, metric, target, note from client_targets;

grant select on v_client_targets to anon, authenticated;

-- Intentionally no INSERT. See the header.

-- ── 3. WHAT CARRIED MONEY, PER ROUND ───────────────────────────────────────
-- Audiences and creatives side by side, one row each per round, with the share
-- of that round's spend. Share is what makes "budget distribution changed"
-- answerable: an audience holding 12% of a round and 34% of the next one is a
-- redistribution even when neither amount looks unusual on its own.
--
-- Leads are joined on because an asset that took money and returned nothing is
-- the case worth surfacing, and it cannot be seen from spend alone.
create or replace view v_round_assets as
with spend as (
  select r.client_id, a.round_id, 'audience'::text as kind,
         coalesce(nullif(btrim(a.ad_set), ''), '(unsplit)') as name,
         sum(a.spend) as spend
  from v_ads a join v_rounds r on r.round_id = a.round_id
  group by 1, 2, 3, 4
  union all
  select r.client_id, a.round_id, 'creative',
         coalesce(nullif(btrim(a.ad), ''), '(unsplit)'),
         sum(a.spend)
  from v_ads a join v_rounds r on r.round_id = a.round_id
  group by 1, 2, 3, 4
),
got as (
  select r.client_id, e.round_id, 'audience'::text as kind,
         coalesce(nullif(btrim(e.ad_set), ''), '(unsplit)') as name,
         count(*) as leads
  from v_events e join v_rounds r on r.round_id = e.round_id
  where e.event_type = 'lead'
  group by 1, 2, 3, 4
  union all
  select r.client_id, e.round_id, 'creative',
         coalesce(nullif(btrim(e.ad), ''), '(unsplit)'),
         count(*)
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
    g.leads
  from spend s
  full outer join got g
    on  g.client_id = s.client_id and g.round_id = s.round_id
    and g.kind = s.kind           and g.name    = s.name
)
select
  client_id, round_id, kind, name,
  spend,
  coalesce(leads, 0)::int as leads,
  -- share of the round's spend, in percent. Null when the round has no spend at
  -- all — a share of nothing is not zero percent, it is nothing.
  round(
    100 * spend / nullif(sum(spend) over (partition by client_id, round_id, kind), 0),
    1
  ) as spend_share
from joined
order by client_id, round_id, kind, spend desc nulls last, name;

grant select on v_round_assets to anon, authenticated;
