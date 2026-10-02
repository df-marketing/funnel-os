-- An ad row keeps the id Meta gave it.
--
-- WHY THIS IS NOT COSMETIC.
--
-- AcqOS matches a sale to a creative on the Meta ad id — a numeric string like
-- 120251317048260425 — against campaign_experiment_variables.external_id. Every
-- Meta export we have ever imported carried that id in a column called "Ad ID",
-- and we dropped it: it is not in the ads field spec, and an unknown column on
-- an ads import is discarded without comment.
--
-- So the one field the integration turns on has been thrown away on every
-- import since the first one.
--
-- WHAT THE ID IS NOT. It is not a property of the creative. Meta mints one ad
-- id per AD SET, so a single creative name has as many ids as audiences it runs
-- against — measured on the 24 Sep export, four names across six ad sets gave
-- 24 ids and 24 distinct (name, ad_set) pairs with no collisions:
--
--     Video_AIInfluencerIsEasy  →  6 ids, one per audience
--     (Video_AIInfluencerIsEasy, Cold_CorporateTrainersEducators) → exactly 1
--
-- That is why this is a column on the ad ROW and not a lookup table keyed on
-- the name. A name-keyed map would have to pick one of six.
--
-- WHY IT DOES NOT JOIN THE DEDUPE KEY.
--
-- The key is (round, date, campaign, ad_set, ad) — lib/import/pipeline.ts:691.
-- ad_id is functionally determined by it, so adding it would change nothing
-- about which rows are distinct, and would change something that matters: every
-- row already stored has a NULL ad_id, so a re-import carrying ids would miss
-- every existing row and insert a duplicate of all of them. It stays an
-- attribute.
--
-- SAFE TO RE-RUN. Adds a nullable column and rebuilds one view through its own
-- frozen column list.

begin;

-- ── 1 · THE COLUMN ─────────────────────────────────────────────────────────
alter table ads_performance add column if not exists ad_id text;

comment on column ads_performance.ad_id is
  'Meta''s own ad id, from the export''s "Ad ID" column. One per (campaign, ad_set, ad) — NOT per creative name. AcqOS resolves a sale to a creative with this.';

-- Looked up two ways: by id, when confirming a sale's source_ref resolves; and
-- by (ad, ad_set), which is how a sale carrying only names finds its id.
--
-- Partial on ad_id, because every row stored before today has none and never
-- will unless its export is re-imported — there is no sense indexing a NULL
-- that outnumbers the values.
--
-- ads_performance has no client_id of its own; it reaches the client through
-- rounds. So neither index can be client-scoped, and neither needs to be — ad
-- ids are globally unique and an (ad, ad_set) pair belongs to one account.
create index if not exists idx_ads_ad_id
  on ads_performance (ad_id) where ad_id is not null;

create index if not exists idx_ads_ad_pair
  on ads_performance (ad, ad_set) where ad_id is not null;

commit;

-- ── 2 · THE VIEW ───────────────────────────────────────────────────────────
-- v_ads was born with a frozen column list and will not grow one on its own:
-- `a.*` inside it means what it meant the day it was created, so a new column
-- on ads_performance is invisible until the view is rebuilt. Rebuilt the same
-- way 20260911100000 did it — read the CURRENT columns, add ours, re-create.
--
-- Separate transaction from the ALTER on purpose: information_schema must see
-- the committed column.
do $do$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_ads';

  if v_cols is null then
    raise exception 'v_ads does not exist; this migration replaces, it does not create';
  end if;

  -- Only if it is genuinely missing, so re-running does not list it twice.
  if position('ad_id' in v_cols) = 0 then
    v_cols := v_cols || ', ad_id';
  end if;

  execute format($f$
    create or replace view v_ads as
    with campaign_dimensions as materialized (select * from v_campaign_dimensions)
    select %s from (
      select r.client_id, a.*, r.product_id, coalesce(d.market, r.country) as country
      from ads_performance a
      join rounds r on r.round_id = a.round_id
      left join campaign_dimensions d
        on d.client_id = r.client_id and d.campaign is not distinct from a.campaign
      where fo_filter_ok(r.product_id, a.channel, coalesce(d.market, r.country),
                         fo_round_anchor(r.code, r.start_date, r.end_date))
        and fo_filter_audience_ok(coalesce(nullif(btrim(a.ad_set), ''), '(unsplit)'))
    ) s
  $f$, v_cols);
end $do$;

grant select on v_ads to anon, authenticated;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. The column exists and the view can see it:
--
--      select ad, ad_set, ad_id from v_ads
--       where client_id = 'shely' limit 5;
--
--    Every ad_id is NULL until an export is re-imported — that is correct, not
--    a failure. Nothing backfills itself.
--
-- 2. Nothing moved. shely's control figures must be untouched:
--
--      select (r->'m'->>'spend')::numeric as spend, (r->'m'->>'leads')::int as leads,
--             (r->'m'->>'att')::int as att, (r->'m'->>'rev')::numeric as rev
--        from fo_cut('v_metrics_total','shely') as r;
--
--    Expect 20474.78 · 1889 · 682 · 83927.00
--
-- 3. After re-importing one Meta export, the pair resolves to exactly one id:
--
--      select ad, ad_set, count(distinct ad_id)
--        from ads_performance where ad_id is not null
--       group by 1,2 having count(distinct ad_id) > 1;
--
--    Zero rows. More than zero means a pair carries two ids and the assumption
--    this column rests on is wrong.
