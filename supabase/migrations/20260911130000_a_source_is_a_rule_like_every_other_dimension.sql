-- ═══════════════════════════════════════════════════════════════════════════
-- 0100 — a source is a rule, like every other dimension.
--
-- REQUIREMENT 3, the half that was never wired.
--
-- The rules engine has resolved five targets since 0073 — market, source,
-- landing_page, product, channel. Count what actually calls it:
--
--     fo_resolve(..., 'market')        11 call sites
--     fo_resolve(..., 'landing_page')   7 call sites
--     fo_resolve(..., 'source')         0
--
-- Market and landing page read their rules. Source never has: attr_source is
-- the raw `events.source` string, carried through untouched. So the Rules screen
-- shipped today can write a perfectly good Affiliate rule and nothing consults
-- it, which is why that tab opens saying "No source rules yet. Everything
-- resolves to nothing." It was telling the truth.
--
-- ── THE SAFETY PROPERTY, AND IT IS THE WHOLE DESIGN ────────────────────────
--
--     coalesce(resolved, raw_source)
--
-- A rule matches      → the rule's key, so Affiliate finally means something.
-- No rule matches     → the raw value, exactly as today.
-- No source at all    → null, which downstream still reads 'Unattributed'.
--
-- With zero source rules in the table, fo_resolve returns null for every row
-- and every figure in the app is bit-for-bit what it was. That is deliberate:
-- this migration can be run and verified BEFORE any rule exists, so if the
-- numbers move, the wiring is wrong rather than the rules being right.
--
-- It also means the change can only ever ADD labelling. Nothing that is named
-- today can become unnamed, which is the failure mode worth engineering against
-- — an unresolved source silently folding into Unattributed would take revenue
-- with it and still sum to 83,927.
--
-- One thing it gives up: a `none`-flagged source value cannot mean "this is not
-- a source". fo_resolve returns null both for "no rule matched" and for "matched
-- a value flagged none", and the coalesce cannot tell them apart, so a none flag
-- falls back to the raw string. Market and landing page keep that ability; source
-- trades it for the guarantee above, and nothing has ever asked for it here.
--
-- ── WHY A LOOKUP AND NOT A CALL PER ROW ────────────────────────────────────
--
-- fo_resolve is STABLE and reads dimension_values on every call. v_attributed_
-- events processes every event row, so the naive form runs it 3,343 times per
-- read — which is 0090's mistake exactly, where fo_resolve ran 4,890 times
-- instead of 52 and took the app down.
--
-- Measured first this time: there are 3,343 event rows and 88 distinct
-- (client, campaign, ad_set, ad, source) tuples. So the resolution is done once
-- per distinct tuple in a MATERIALIZED cte and joined back — roughly 88 calls,
-- not 3,343, and every one of the four fields a rule may match on stays
-- available. `is not distinct from` on the join because all four are nullable
-- and `=` would drop every row with a null campaign.
--
-- ── HOW THE COLUMN IS REPLACED ─────────────────────────────────────────────
--
-- attr_source arrives inside `a.*` from v_event_attribution, and Postgres has no
-- SELECT * EXCEPT, so it cannot be shadowed. The view already builds its select
-- list from information_schema (20260911100000, because `a.*` froze wider than
-- the live view) — so the list is built with one column swapped for an
-- expression and every other column qualified to p. No column is added, removed
-- or reordered.
--
-- The filter uses the resolved value too. Labelling by rule while filtering by
-- raw string would let SOURCE → Affiliate return nothing on a screen that had
-- just drawn an Affiliate column.
--
-- Safe to re-run. Section 2 is an OPTIONAL seed, in its own transaction.
--
-- ROLLBACK: re-run the v_attributed_events block from 20260911100000.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. THE WIRING ═════════════════════════════════════════════════════════
begin;

do $do$
declare
  v_cols text;
begin
  /* Every column as it stands, with attr_source alone swapped for the resolved
     expression. Built rather than typed, for the reason in the header. */
  select string_agg(
           case when column_name = 'attr_source'
                then 'coalesce(m.resolved, p.attr_source) as attr_source'
                else 'p.' || quote_ident(column_name) end,
           ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_attributed_events';

  if v_cols is null then
    raise exception 'v_attributed_events does not exist; this migration replaces, it does not create';
  end if;
  if v_cols not like '%coalesce(m.resolved%' then
    raise exception 'v_attributed_events has no attr_source column — refusing to guess which column to resolve';
  end if;

  execute format($f$
    create or replace view v_attributed_events as
    with campaign_dimensions as materialized (select * from v_campaign_dimensions),
    entry_context as materialized (select * from v_contact_entry),
    prepared as (
      select a.*,
             coalesce(d.market, r.country) as attr_country,
             r.product_id as attr_product_id,
             r.start_date as attr_start_date,
             r.end_date   as attr_end_date,
             case
               when a.event_type = 'attendance' then c.attr_ad_set
               when a.event_type = 'sale' then a.attr_ad_set
               else a.ad_set
             end as attr_audience,
             case when a.event_type = 'attendance' then c.attr_ad else a.attr_ad end as attr_creative,
             fo_round_anchor(r.code, r.start_date, r.end_date) as attr_anchor
      from v_event_attribution a
      join rounds r on r.client_id = a.client_id and r.round_id = a.attr_round_id
      left join campaign_dimensions d
        on d.client_id = a.client_id and d.campaign is not distinct from a.attr_utm_campaign
      left join entry_context c
        on c.client_id = a.client_id and c.contact_id = a.contact_id
    ),
    /* Once per distinct tuple, not once per row. 88 against 3,343. */
    src_map as materialized (
      select k.client_id, k.campaign, k.ad_set, k.ad, k.source,
             fo_resolve(k.client_id, 'source', k.campaign, k.ad_set, k.ad, k.source) as resolved
      from (
        select distinct client_id,
               attr_utm_campaign as campaign,
               attr_ad_set       as ad_set,
               attr_ad           as ad,
               attr_source       as source
        from prepared
      ) k
    )
    select %s
    from prepared p
    left join src_map m
      on  m.client_id = p.client_id
      and m.campaign is not distinct from p.attr_utm_campaign
      and m.ad_set   is not distinct from p.attr_ad_set
      and m.ad       is not distinct from p.attr_ad
      and m.source   is not distinct from p.attr_source
    where fo_filter_people_ok(p.attr_product_id, p.attr_country, p.attr_anchor)
      -- the RESOLVED value, so a filter cannot disagree with the column it filters
      and fo_filter_source_ok(coalesce(m.resolved, p.attr_source, 'Unattributed'))
      and fo_filter_audience_ok(coalesce(nullif(btrim(p.attr_audience), ''), '(unsplit)'))
  $f$, v_cols);
end
$do$;
grant select on v_attributed_events to anon, authenticated;

commit;

-- ═══ 2. OPTIONAL — name the four buckets Shely already has ═════════════════
-- Not required by section 1 and deliberately separate. Each rule maps a value
-- to ITSELF, so it cannot move a number: 'Paid Ads' resolved from 'Paid Ads' is
-- 'Paid Ads'. What it changes is that the Rules screen stops saying "no source
-- rules yet" and starts showing the four that are really in use — which is the
-- point of the screen, and the thing that makes Affiliate look like one more
-- row rather than a special case.
--
-- Run section 1 and CHECK IT FIRST. If the totals hold with no rules at all,
-- the wiring is proven; only then does seeding prove anything about rules.
--
-- No catch-all is created. Anything unmatched falls back to its raw string, and
-- a row with no source at all still reads Unattributed downstream.
begin;

insert into dimension_values (client_id, target, key, label, ord, note, flags, rules)
values
  ('shely', 'source', 'Paid Ads', 'Paid Ads', 10,
   'What the CRM export writes for a lead that arrived through a paid campaign.',
   '{}'::jsonb,
   '[{"op":"is","field":"source","value":"Paid Ads"}]'::jsonb),
  ('shely', 'source', 'Organic', 'Organic', 20,
   'No paid touch behind it. Not an absence of tracking — an absence of spend.',
   '{}'::jsonb,
   '[{"op":"is","field":"source","value":"Organic"}]'::jsonb),
  ('shely', 'source', 'AOAI', 'AOAI', 30,
   'A source someone typed in as a row. No code was ever written for it.',
   '{}'::jsonb,
   '[{"op":"is","field":"source","value":"AOAI"}]'::jsonb),
  ('shely', 'source', 'Tracking not captured', 'Tracking not captured', 40,
   'The tracking did not fire. Named rather than dropped, because binning it or '
   'guessing Organic would both stop 1,889 adding up.',
   '{}'::jsonb,
   '[{"op":"is","field":"source","value":"Tracking not captured"}]'::jsonb)
on conflict (client_id, target, key) do nothing;

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. AFTER SECTION 1, BEFORE SECTION 2 — nothing may move. With no source rules
--    the resolution is null everywhere and the coalesce falls back to raw:
--
--      select (r->'m'->>'spend')::numeric as spend, (r->'m'->>'leads')::int as leads,
--             (r->'m'->>'att')::int as att, (r->'m'->>'rev')::numeric as rev
--        from fo_cut('v_metrics_total','shely') as r;
--
--    Expect 20474.78 · 1889 · 682 · 83927.00. If any of these moved, STOP and
--    roll back — the wiring is wrong, not the rules.
--
-- 2. THE SPLIT, which is the part a total would hide:
--
--      select r->>'cut_label' as source, (r->'m'->>'leads')::int as leads
--        from fo_cut('v_metrics_by_source','shely') as r;
--
--    Expect Paid Ads 1520 · Organic 307 · AOAI 61 · Tracking not captured 1 ·
--    Unattributed 0, summing to 1889 — identical to before.
--
-- 3. AFTER SECTION 2 — run 1 and 2 again. Every figure must be the same a THIRD
--    time. Each rule maps a value to itself, so a change here means a rule is
--    matching something it should not.
--
-- 4. THE POINT OF ALL OF IT. Create an Affiliate rule on the Rules screen
--    (source column · is exactly · affiliate_partner), then:
--
--      select fo_resolve('shely','source',null,null,null,'affiliate_partner');
--
--    Expect 'Affiliate'. That is a source that exists because somebody wrote a
--    row, with no deploy and no re-import — which is the requirement.
--
-- 5. SPEED, because this added a join to the hottest view in the app:
--
--      explain analyze select count(*) from v_events where client_id = 'shely';
--
--    src_map should appear once as a CTE scan of roughly 88 rows. If fo_resolve
--    shows thousands of calls, the materialized cte was not honoured and this
--    should come straight back out.
