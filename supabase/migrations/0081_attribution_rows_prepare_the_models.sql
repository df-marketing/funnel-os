-- ═══════════════════════════════════════════════════════════════════════════
-- 0081 — attribution is rows, not a second stored fact.
--
-- A sale is one fact. The attribution model decides where its credit appears;
-- it must not rewrite the sale, its amount, or the round where it happened.
-- This view produces those credit rows at read time. Entry is one row, and
-- Even Split is one row per earlier round the buyer appeared in, with weights
-- that add to one.
--
-- This is deliberately a preparation migration. Existing metric views still
-- read v_events, so the app's displayed figures remain byte-for-byte unchanged
-- until the next migration moves every sales aggregation onto these rows.
-- That gives the new calculation one isolated place to prove before it can
-- redistribute reported revenue.
--
-- ROLLBACK: drop view v_event_attribution, function fo_attribution_model and
-- idx_events_contact_date_type. No source data is changed.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- The selector is transaction-local like product, country and source. An
-- unknown value reads as Entry rather than allowing a typo to quietly create a
-- sixth model. fo_cut will set this value when the metric readers move over.
create or replace function fo_attribution_model()
returns text
language sql
stable
as $$
  select case coalesce(nullif(current_setting('funnel.attribution', true), ''), 'entry')
    when 'entry'       then 'entry'
    when 'entry_paid'  then 'entry_paid'
    when 'last_touch'  then 'last_touch'
    when 'last_paid'   then 'last_paid'
    when 'even_split'  then 'even_split'
    else 'entry'
  end;
$$;

grant execute on function fo_attribution_model() to anon, authenticated;

-- Every model looks up a buyer's prior touches by contact and instant. This is
-- a small, targeted index: it also serves the importer’s existing first-lead
-- and latest-attendance lookups without changing their answers.
create index if not exists idx_events_contact_date_type
  on events (contact_id, event_date, event_type)
  where contact_id is not null;

create or replace view v_event_attribution as
with
model as materialized (
  select fo_attribution_model() as name
),
base as materialized (
  select
    r.client_id,
    e.event_id, e.contact_id, e.round_id, e.event_type, e.event_date,
    e.lead_round_id, e.close_round_id, e.attribution_method, e.utm_campaign,
    e.source, e.match_status, e.product, e.minutes_watched,
    e.amount, e.refund_amount, e.refund_date, e.is_lead, e.import_batch_id,
    e.ad_set, e.ad, e.variant, r.product_id,
    coalesce(e.country, r.country) as country
  from events e
  join rounds r on r.round_id = e.round_id
),
sales as materialized (
  select * from base where event_type = 'sale'
),
-- Each of the four single-credit models chooses one lead before the sale. A
-- lead after payment is not allowed to claim it. A buyer with no qualifying
-- lead falls back to the round where the sale happened, exactly as 0052 does.
entry_touch as materialized (
  select distinct on (s.event_id)
    s.event_id as sale_id, l.round_id, l.source, l.utm_campaign, l.ad_set, l.ad, l.variant
  from sales s
  join base l on l.client_id = s.client_id
             and l.contact_id = s.contact_id
             and l.event_type = 'lead'
             and l.event_date <= s.event_date
  order by s.event_id, l.event_date, l.event_id
),
entry_paid_touch as materialized (
  select distinct on (s.event_id)
    s.event_id as sale_id, l.round_id, l.source, l.utm_campaign, l.ad_set, l.ad, l.variant
  from sales s
  join base l on l.client_id = s.client_id
             and l.contact_id = s.contact_id
             and l.event_type = 'lead'
             and l.source = 'Paid Ads'
             and l.event_date <= s.event_date
  order by s.event_id, l.event_date, l.event_id
),
last_touch as materialized (
  select distinct on (s.event_id)
    s.event_id as sale_id, l.round_id, l.source, l.utm_campaign, l.ad_set, l.ad, l.variant
  from sales s
  join base l on l.client_id = s.client_id
             and l.contact_id = s.contact_id
             and l.event_type = 'lead'
             and l.event_date <= s.event_date
  order by s.event_id, l.event_date desc, l.event_id desc
),
last_paid_touch as materialized (
  select distinct on (s.event_id)
    s.event_id as sale_id, l.round_id, l.source, l.utm_campaign, l.ad_set, l.ad, l.variant
  from sales s
  join base l on l.client_id = s.client_id
             and l.contact_id = s.contact_id
             and l.event_type = 'lead'
             and l.source = 'Paid Ads'
             and l.event_date <= s.event_date
  order by s.event_id, l.event_date desc, l.event_id desc
),
-- A round counts once, no matter how many lead or attendance rows the person
-- has in it. Sales are intentionally excluded: a purchase cannot create its
-- own prior touch. Within a round, prefer the most recent named lead so the
-- source and ad context remain useful to later audience/creative readers.
even_touch_once as materialized (
  select distinct on (s.event_id, p.round_id)
    s.event_id as sale_id, p.round_id, p.source, p.utm_campaign, p.ad_set, p.ad, p.variant
  from sales s
  join base p on p.client_id = s.client_id
             and p.contact_id = s.contact_id
             and p.event_type in ('lead', 'attendance')
             and p.round_id is not null
             and p.event_date <= s.event_date
  order by s.event_id, p.round_id,
           case when p.event_type = 'lead' then 0 else 1 end,
           p.event_date desc, p.event_id desc
),
even_touch as materialized (
  select
    sale_id, round_id, source, utm_campaign, ad_set, ad, variant,
    1::numeric / count(*) over (partition by sale_id) as attr_weight
  from even_touch_once
),
selected_touch as materialized (
  select e.sale_id, e.round_id, e.source, e.utm_campaign, e.ad_set, e.ad, e.variant, 1::numeric as attr_weight
  from entry_touch e cross join model m where m.name = 'entry'
  union all
  select e.sale_id, e.round_id, e.source, e.utm_campaign, e.ad_set, e.ad, e.variant, 1::numeric
  from entry_paid_touch e cross join model m where m.name = 'entry_paid'
  union all
  select e.sale_id, e.round_id, e.source, e.utm_campaign, e.ad_set, e.ad, e.variant, 1::numeric
  from last_touch e cross join model m where m.name = 'last_touch'
  union all
  select e.sale_id, e.round_id, e.source, e.utm_campaign, e.ad_set, e.ad, e.variant, 1::numeric
  from last_paid_touch e cross join model m where m.name = 'last_paid'
  union all
  select e.sale_id, e.round_id, e.source, e.utm_campaign, e.ad_set, e.ad, e.variant, e.attr_weight
  from even_touch e cross join model m where m.name = 'even_split'
),
attributed_sales as (
  select
    s.*,
    coalesce(t.round_id, s.round_id) as attr_round_id,
    coalesce(t.source, s.source) as attr_source,
    coalesce(t.utm_campaign, s.utm_campaign) as attr_utm_campaign,
    coalesce(t.ad_set, s.ad_set) as attr_ad_set,
    coalesce(t.ad, s.ad) as attr_ad,
    coalesce(t.variant, s.variant) as attr_variant,
    coalesce(t.attr_weight, 1::numeric) as attr_weight
  from sales s
  left join selected_touch t on t.sale_id = s.event_id
)
-- Leads and attendance never split. Only a sale may appear more than once,
-- and every duplicate carries a fractional weight that later metrics must SUM.
select
  b.*,
  b.round_id as attr_round_id,
  b.source as attr_source,
  b.utm_campaign as attr_utm_campaign,
  b.ad_set as attr_ad_set,
  b.ad as attr_ad,
  b.variant as attr_variant,
  1::numeric as attr_weight
from base b
where b.event_type <> 'sale'

union all

select
  s.client_id,
  s.event_id, s.contact_id, s.round_id, s.event_type, s.event_date,
  s.lead_round_id, s.close_round_id, s.attribution_method, s.utm_campaign,
  s.source, s.match_status, s.product, s.minutes_watched,
  s.amount, s.refund_amount, s.refund_date, s.is_lead, s.import_batch_id,
  s.ad_set, s.ad, s.variant, s.product_id, s.country,
  s.attr_round_id, s.attr_source, s.attr_utm_campaign, s.attr_ad_set,
  s.attr_ad, s.attr_variant, s.attr_weight
from attributed_sales s;

comment on view v_event_attribution is
  'Raw events plus read-time attribution. A sale is one row under entry/last '
  'models and one weighted row per earlier touch under even_split. Leads and '
  'attendance are never divided.';

grant select on v_event_attribution to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING, THROUGH THE APP'S ANON KEY ───────────────────────
-- With no funnel.attribution set, this view is Entry. For every client:
--   sum(attr_weight) over sale rows = count(distinct event_id) over sale rows.
-- After SET LOCAL funnel.attribution = 'even_split', sum(attr_weight) is still
-- that same count, while lead and attendance rows each retain attr_weight = 1.
