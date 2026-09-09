-- ═══════════════════════════════════════════════════════════════════════════
-- 0073 — a rule is a row, not a CASE statement.
--
-- What a campaign name MEANS is currently written in two functions:
--
--     fo_country()       ^DF_([A-Z]{2})_          → 'SG', 'MY'
--     fo_landing_page()  a seven-branch CASE      → 'LP1', 'LP2', 'Lead Form'
--
-- Both are correct and both are code. Adding "Affiliate" — a real request —
-- means writing a migration, having somebody run it, and deploying. For one
-- word. And every rule that has ever been added had to be hand-ordered, because
-- 'LP2' contains 'LP' and the branches are tried in sequence.
--
-- This migration puts the knowledge in a table and gives it a reader. It does
-- NOT change any view, so nothing on screen moves. That is deliberate: this
-- migration must be provably inert before anything is rewired to it.
--
-- ── WHAT A VALUE IS ───────────────────────────────────────────────────────
-- One row per Paid Ads, Affiliate, MY, SG, LP1, Lead Form, product, channel.
-- `target` says which dimension it belongs to. `ord` is its priority, so
-- "LP2 is checked before LP1" is just LP2 sitting higher in the list rather
-- than a separate priority integer nobody can see.
--
-- Its rules ride on the value as a jsonb array. There is no second table: a
-- rule has no meaning apart from the value it resolves to, and splitting them
-- would let a rule exist pointing at nothing.
--
-- ── WHAT A RULE MATCHES ON ────────────────────────────────────────────────
-- Four fields, every one already stored on the row today:
--
--     campaign   utm_campaign, verbatim      market, page, product, channel
--     ad_set     utm_term                    audience
--     ad         utm_content                 creative
--     source     the export's own column     source, including affiliate
--
-- The fourth is what makes Affiliate work without capturing utm_source, which
-- this app has never stored. Do not build campaign-only matching.
--
-- ── TWO KINDS OF VALUE THAT ARE NOT VALUES ────────────────────────────────
-- flags.none      matching means "resolve to nothing". A merge tag that never
--                 rendered is broken tracking, not a landing page, and must
--                 stay null rather than falling into the catch-all.
-- flags.catch_all matches anything not already matched. 'Lead Form' is this:
--                 a real campaign that names no page IS the direct form.
--
-- ── WHAT THIS DELIBERATELY CHANGES ────────────────────────────────────────
-- fo_country() returns whatever two letters follow DF_. A DF_TH_ campaign
-- silently becomes market 'TH' — a market nobody defined, that appears in no
-- list, and that no filter offers. The rules name SG and MY explicitly, so an
-- undefined prefix resolves to nothing and shows up as a visible Unknown
-- instead. There is no DF_TH_ in the data, so nothing moves today; the check
-- block below proves it.
--
-- Safe to re-run. Creates nothing that any view reads yet.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create table if not exists dimension_values (
  id        uuid primary key default gen_random_uuid(),
  client_id text not null,
  target    text not null check (target in ('market','source','landing_page','product','channel')),
  key       text not null,
  label     text,
  ord       int  not null default 100,
  note      text,
  -- none: matching resolves to NULL. catch_all: matches whatever is left.
  flags     jsonb not null default '{}'::jsonb,
  -- [{ "field": "campaign", "op": "regex", "value": "LP\\s*2" }, ...]
  -- A value matches if ANY of its rules match. Rules within a value are OR.
  rules     jsonb not null default '[]'::jsonb,
  unique (client_id, target, key)
);

comment on table dimension_values is
  'What a campaign name means, as data. One row per market, source, landing '
  'page, product or channel, carrying the rules that resolve to it. Replaces '
  'fo_country and fo_landing_page, which held the same knowledge as code.';

create index if not exists idx_dimension_values_lookup
  on dimension_values (client_id, target, ord, id);

grant select on dimension_values to anon, authenticated;

-- ── ONE RULE ──────────────────────────────────────────────────────────────
-- Case-insensitive by default, because campaign names are typed by people and
-- 'lp2' and 'LP2' are the same intention. Regex is the escape hatch, not the
-- habit — but the two functions being replaced are both regex, so it carries
-- the whole of today's behaviour on day one.
create or replace function fo_rule_ok(
  p_rule    jsonb,
  p_campaign text, p_ad_set text, p_ad text, p_source text
) returns boolean
language sql
immutable
as $$
  with r as (
    select
      coalesce(p_rule->>'op', 'contains')                        as op,
      coalesce(p_rule->>'value', '')                             as val,
      case coalesce(p_rule->>'field', 'campaign')
        when 'campaign' then p_campaign
        when 'ad_set'   then p_ad_set
        when 'ad'       then p_ad
        when 'source'   then p_source
      end                                                        as fld
  )
  select case r.op
    when 'contains'      then upper(coalesce(r.fld,'')) like '%' || upper(r.val) || '%'
    when 'not_contains'  then upper(coalesce(r.fld,'')) not like '%' || upper(r.val) || '%'
    when 'is'            then upper(btrim(coalesce(r.fld,''))) = upper(btrim(r.val))
    when 'is_not'        then upper(btrim(coalesce(r.fld,''))) <> upper(btrim(r.val))
    when 'starts_with'   then upper(coalesce(r.fld,'')) like upper(r.val) || '%'
    when 'ends_with'     then upper(coalesce(r.fld,'')) like '%' || upper(r.val)
    when 'is_empty'      then btrim(coalesce(r.fld,'')) = ''
    when 'is_not_empty'  then btrim(coalesce(r.fld,'')) <> ''
    when 'one_of'        then upper(btrim(coalesce(r.fld,''))) = any (
                               select upper(btrim(x)) from unnest(string_to_array(r.val, ',')) x)
    when 'regex'         then coalesce(r.fld,'') ~* r.val
    -- An operator nobody implemented must not quietly match everything.
    else false
  end
  from r;
$$;

grant execute on function fo_rule_ok(jsonb, text, text, text, text) to anon, authenticated;

-- ── THE READER ────────────────────────────────────────────────────────────
-- Values in their own order; the first whose rules match wins. A value with
-- flags.none resolves to NULL rather than to itself, which is how "this is not
-- a landing page at all" is said.
create or replace function fo_resolve(
  p_client text, p_target text, p_campaign text,
  p_ad_set text default null, p_ad text default null, p_source text default null
) returns text
language sql
stable
as $$
  select case when (v.flags->>'none')::boolean then null else v.key end
  from dimension_values v
  where v.client_id = p_client
    and v.target    = p_target
    and (
      (v.flags->>'catch_all')::boolean
      or exists (
        select 1 from jsonb_array_elements(v.rules) rule
        where fo_rule_ok(rule, p_campaign, p_ad_set, p_ad, p_source)
      )
    )
  order by v.ord, v.id
  limit 1;
$$;

grant execute on function fo_resolve(text, text, text, text, text, text) to anon, authenticated;

comment on function fo_resolve(text, text, text, text, text, text) is
  'The label a row resolves to for one dimension. Values are tried in their own '
  'display order and the first match wins, so "LP2 before LP1" is a position in '
  'a list rather than a hidden priority number. Resolved at read: change a rule '
  'and every past round restates with nothing re-imported.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED — these rules reproduce today's two functions exactly.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── MARKET, for every client that has DF_XX_ campaigns ────────────────────
insert into dimension_values (client_id, target, key, label, ord, note, rules) values
  ('shely', 'market', 'SG', 'Singapore', 10,
   'The DF_SG_ prefix every Singapore campaign carries.',
   '[{"field":"campaign","op":"regex","value":"^DF_SG_"}]'::jsonb),
  ('shely', 'market', 'MY', 'Malaysia', 20,
   'The DF_MY_ prefix. 0926-01 ran both markets at once, which is why market '
   'lives on the row and never on the round.',
   '[{"field":"campaign","op":"regex","value":"^DF_MY_"}]'::jsonb)
on conflict (client_id, target, key) do update
  set label = excluded.label, ord = excluded.ord,
      note = excluded.note, rules = excluded.rules;

-- ── LANDING PAGE ──────────────────────────────────────────────────────────
-- Order matters and is the whole point: 'LP2' contains 'LP', so LP2 is asked
-- first. The three exclusions come before everything, because a merge tag or a
-- bare Meta id must resolve to nothing rather than to the catch-all.
insert into dimension_values (client_id, target, key, label, ord, note, flags, rules) values
  ('shely', 'landing_page', '(not a page)', null, 5,
   'Nothing to read, an unrendered merge tag, or a bare Meta campaign id. '
   'Broken tracking is not a landing page and must not become the lead form.',
   '{"none": true}'::jsonb,
   '[{"field":"campaign","op":"is_empty","value":""},
     {"field":"campaign","op":"contains","value":"{{"},
     {"field":"campaign","op":"regex","value":"^\\s*[0-9][0-9\\s,._-]*$"}]'::jsonb),

  ('shely', 'landing_page', 'LP2', 'Landing page 2', 10,
   'Asked before LP1 because the string LP2 contains LP.',
   '{}'::jsonb,
   '[{"field":"campaign","op":"regex","value":"LP\\s*2"}]'::jsonb),

  ('shely', 'landing_page', 'LP1', 'Landing page 1', 20,
   'LP1 and its variants, plus a bare LP — the client confirmed those two '
   'campaigns, worth $1,970, were LP1.',
   '{}'::jsonb,
   '[{"field":"campaign","op":"regex","value":"LP\\s*1"},
     {"field":"campaign","op":"regex","value":"LP"}]'::jsonb),

  ('shely', 'landing_page', 'Lead Form', 'Lead form', 90,
   'A real campaign naming no page IS the direct lead form — an arm of the '
   'test, not an absence.',
   '{"catch_all": true}'::jsonb, '[]'::jsonb)
on conflict (client_id, target, key) do update
  set label = excluded.label, ord = excluded.ord, note = excluded.note,
      flags = excluded.flags, rules = excluded.rules;

-- ── THE DEMO CLIENT ───────────────────────────────────────────────────────
-- northsea_supply has no DF_ prefix and no page token, so today it resolves to
-- no market and to 'Lead Form'. Seeded so that rewiring the views later leaves
-- it exactly where it is. Its rounds are AcqOS fixtures and are not touched.
insert into dimension_values (client_id, target, key, label, ord, note, flags, rules) values
  ('northsea_supply', 'landing_page', '(not a page)', null, 5,
   'Same exclusions as every client.',
   '{"none": true}'::jsonb,
   '[{"field":"campaign","op":"is_empty","value":""},
     {"field":"campaign","op":"contains","value":"{{"},
     {"field":"campaign","op":"regex","value":"^\\s*[0-9][0-9\\s,._-]*$"}]'::jsonb),
  ('northsea_supply', 'landing_page', 'LP2', 'Landing page 2', 10, null,
   '{}'::jsonb, '[{"field":"campaign","op":"regex","value":"LP\\s*2"}]'::jsonb),
  ('northsea_supply', 'landing_page', 'LP1', 'Landing page 1', 20, null,
   '{}'::jsonb, '[{"field":"campaign","op":"regex","value":"LP\\s*1"},
                  {"field":"campaign","op":"regex","value":"LP"}]'::jsonb),
  ('northsea_supply', 'landing_page', 'Lead Form', 'Lead form', 90, null,
   '{"catch_all": true}'::jsonb, '[]'::jsonb)
on conflict (client_id, target, key) do update
  set label = excluded.label, ord = excluded.ord, note = excluded.note,
      flags = excluded.flags, rules = excluded.rules;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- CHECK AFTER RUNNING — all three must return zero rows.
--
-- Nothing on screen can have changed, because no view calls fo_resolve yet.
-- These prove the rules would give the same answer when it does.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. MARKET agrees with fo_country on every campaign in the ads table.
select a.campaign, fo_country(a.campaign) as old, fo_resolve(r.client_id, 'market', a.campaign) as new
from ads_performance a join rounds r on r.round_id = a.round_id
group by 1,2,3
having fo_country(a.campaign) is distinct from fo_resolve(r.client_id, 'market', a.campaign);

-- 2. LANDING PAGE agrees with fo_landing_page on every campaign in the ads table.
select a.campaign, fo_landing_page(a.campaign) as old,
       fo_resolve(r.client_id, 'landing_page', a.campaign) as new
from ads_performance a join rounds r on r.round_id = a.round_id
group by 1,2,3
having fo_landing_page(a.campaign) is distinct from fo_resolve(r.client_id, 'landing_page', a.campaign);

-- 3. And on every campaign a LEAD carries, which is the other half of the data.
select e.utm_campaign,
       fo_country(e.utm_campaign)      as old_market,
       fo_resolve(r.client_id, 'market', e.utm_campaign)       as new_market,
       fo_landing_page(e.utm_campaign) as old_page,
       fo_resolve(r.client_id, 'landing_page', e.utm_campaign) as new_page
from events e join rounds r on r.round_id = e.round_id
group by 1,2,3,4,5
having fo_country(e.utm_campaign) is distinct from fo_resolve(r.client_id, 'market', e.utm_campaign)
    or fo_landing_page(e.utm_campaign) is distinct from fo_resolve(r.client_id, 'landing_page', e.utm_campaign);

-- 4. And the seed landed: 2 market rows, 4 landing-page rows for shely.
select target, count(*) from dimension_values where client_id = 'shely' group by 1 order by 1;
--   landing_page | 4
--   market       | 2
