-- ═══════════════════════════════════════════════════════════════════════════
-- 0062 — a round can run two countries, so the country is not the round's.
--
-- 0061 put country on the ROUND, which is what the brief said, and the brief
-- was wrong. 0926-01 ran BOTH: DF_SG_ campaigns spending $2,946.46 beside
-- DF_MY_ campaigns spending $989.34, 102 leads against 242. The back-fill saw
-- two prefixes, refused to guess, and left the round null — correct, and
-- useless. The filter offered SG and no MY at all, and selecting SG deleted
-- September from the app, because the only round MY ever ran in was the one
-- excluded from both.
--
-- The country is on the AD ROW and on the LEAD, where it always was:
--
--     ads_performance.campaign     DF_MY_Preview_Sprint1_0926_01_LP1GHL
--     events.utm_campaign          the same string, written by the tracking link
--
-- SG $19,485.25 against MY $989.53 of spend, 1,251 SG leads against 247 MY.
--
-- ── HOW A NON-LEAD EVENT GETS ONE ─────────────────────────────────────────
-- An attendance row carries no campaign — nobody clicks an ad to attend. It
-- inherits the country of the lead that acquired the person, written at import
-- (see pipeline.ts). Inheriting is right here and wrong for a landing page,
-- because a country is a fact about a person and a page is a door for one
-- round.
--
-- rounds.country stays as the fallback for a round whose campaigns say nothing,
-- and 0061's back-fill still runs. A round that genuinely ran one country keeps
-- answering when its ad rows are silent.
--
-- Safe to re-run. Requires re-importing leads, attendance and sales to fill
-- events.country; until then those rows fall back to the round.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function fo_country(p_campaign text)
returns text
language sql
immutable
as $$
  -- DF_SG_..., DF_MY_... — the prefix every campaign in this account carries.
  -- Anything else is not a country and is not guessed into one.
  select nullif(substring(coalesce(p_campaign, '') from '^DF_([A-Z]{2})_'), '');
$$;

grant execute on function fo_country(text) to anon, authenticated;

alter table events add column if not exists country text;

comment on column events.country is
  'Which country''s campaign brought this person in, from the DF_XX_ prefix on '
  'their acquiring lead. Inherited by their later events. Null means no campaign '
  'said, which falls back to the round and is not a guess.';

create index if not exists idx_events_country
  on events (round_id, country) where country is not null;

-- ── A BARE "LP" IS LP1 ─────────────────────────────────────────────────────
-- 0058 left two campaigns unmapped — 0626_02_LP and 0726_01_AI_LP, $1,970 —
-- because "LP" with no number could have been the original single page or LP1
-- and nothing in the data decided it. The client has now said: they are LP1.
create or replace function fo_landing_page(p_campaign text)
returns text
language sql
immutable
as $$
  select case
    when p_campaign is null then null
    when upper(p_campaign) ~ 'LP\s*2' then 'LP2'
    -- LP1GHL, LP1GHLHenry, LP1GHL(0826_02), LP1GHL_AcqOS, LP1 — and a bare LP,
    -- which the client confirms was LP1. LP2 is tested first so "LP2" cannot be
    -- swallowed by the bare-LP branch.
    when upper(p_campaign) ~ 'LP' then 'LP1'
  end;
$$;

grant execute on function fo_landing_page(text) to anon, authenticated;

-- ── THE FILTER READS THE ROW, THEN THE ROUND ───────────────────────────────
create or replace view v_ads as
select r.client_id, a.*, r.product_id,
       coalesce(fo_country(a.campaign), r.country) as country
from ads_performance a
join rounds r on r.round_id = a.round_id
where fo_filter_ok(r.product_id, a.channel,
                   coalesce(fo_country(a.campaign), r.country),
                   r.start_date, r.end_date);

create or replace view v_events as
select
  r.client_id,
  e.event_id, e.contact_id, e.round_id, e.event_type, e.event_date,
  e.lead_round_id, e.close_round_id, e.attribution_method, e.utm_campaign,
  e.source, e.match_status, e.product, e.minutes_watched,
  e.amount, e.refund_amount, e.refund_date, e.is_lead, e.import_batch_id,
  case
    when e.source = 'Paid Ads'
     and coalesce(e.close_round_id, e.round_id) is distinct from e.lead_round_id
      then 'Previous Paid Ads'
    else e.source
  end as attribution_bucket,
  e.ad_set,
  e.ad,
  r.product_id,
  e.variant,
  -- the row's own country first: the lead's campaign said it, or the import
  -- inherited it from the lead that acquired this person
  coalesce(e.country, fo_country(e.utm_campaign), r.country) as country
from events e
join rounds r on r.round_id = e.round_id
where fo_filter_people_ok(r.product_id,
                          coalesce(e.country, fo_country(e.utm_campaign), r.country),
                          r.start_date, r.end_date);

grant select on v_ads, v_events to anon, authenticated;

commit;
