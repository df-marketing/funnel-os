-- ═══════════════════════════════════════════════════════════════════════════
-- 0071 — a round hands back the country that matched, not the whole selection.
--
-- 0070 was necessary and not sufficient, and running it changed nothing. This is
-- the other half.
--
-- 0064 got v_rounds past a problem with a trick: a round that ran two countries
-- has no country of its own, so rather than compare it, feed the CHOSEN country
-- back into fo_filter_people_ok when the round qualifies, and NULL when it does
-- not. Equal by construction. That worked exactly as long as the choice was one
-- value.
--
-- 0068 made it a set, and the trick inverts:
--
--     funnel.country      'SG,MY'
--     fed to the predicate 'SG,MY'      ← the whole string, as if it were one
--     predicate splits to  ['SG','MY']
--     'SG,MY' = any(['SG','MY'])        → false
--
-- The round passes fo_round_country_ok and is then rejected by the predicate it
-- was just proven to satisfy. Only v_rounds does this, so only the views that
-- join it — By round and By month — went empty, under a journey strip still
-- reporting $20,474.78 and 1,848 leads. One screen, two answers.
--
-- The trick is the bug. A round should hand back A MEMBER of the selection that
-- it actually matched, which is a country, and which the predicate can compare
-- like any other. fo_round_country_pick returns that member — the round's own
-- country when it declares one in the set, otherwise the first member its ad
-- rows or its people vouch for, and NULL when none does.
--
-- fo_round_country_ok stays. 0070 made it correct and it is worth keeping as the
-- readable statement of the rule; nothing is dropped, so nothing that calls it
-- needs touching.
--
-- Safe to re-run. Same columns, same order — only which rows come back changes.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function fo_round_country_pick(p_round_id text, p_round_country text)
returns text
language sql
stable
as $$
  with f as (
    select nullif(
             string_to_array(nullif(current_setting('funnel.country', true), ''), ','),
             '{}'
           ) as cs
  )
  select case
    -- Nothing chosen. Hand back the round's own value; the predicate ignores the
    -- country entirely in this case, so anything non-committal would do — but its
    -- own value is the honest one.
    when f.cs is null then p_round_country

    -- The round declares a country and it was chosen.
    when p_round_country = any(f.cs) then p_round_country

    -- Otherwise: the first chosen country this round can actually vouch for,
    -- because it bought traffic there or because somebody in it came from there.
    -- Any single match is enough to admit the round; v_ads and v_events then
    -- narrow what is counted INSIDE it, per row.
    else (
      select m
      from unnest(f.cs) m
      where exists (
              select 1 from ads_performance a
               where a.round_id = p_round_id
                 and fo_country(a.campaign) = m
            )
         or exists (
              select 1 from events e
               where e.round_id = p_round_id
                 and coalesce(e.country, fo_country(e.utm_campaign)) = m
            )
      limit 1
    )
    -- NULL when no member matches, which fails the predicate. Correct: the round
    -- ran in none of the chosen countries.
  end
  from f;
$$;

grant execute on function fo_round_country_pick(text, text) to anon, authenticated;

comment on function fo_round_country_pick(text, text) is
  'A country from the current selection that this round genuinely ran in, for '
  'fo_filter_people_ok to compare. Its own when it declares one that was chosen, '
  'otherwise one its ad rows or its people vouch for, NULL when none does. '
  'Replaces 0064''s trick of feeding the whole selection back, which stopped '
  'being a single value in 0068.';

create or replace view v_rounds as
select r.*
from rounds r
where fo_filter_people_ok(
        r.product_id,
        -- A country the round actually ran in, or NULL if it ran in none of the
        -- chosen ones. Never the selection itself.
        fo_round_country_pick(r.round_id, r.country),
        r.start_date, r.end_date
      );

grant select on v_rounds to anon, authenticated;

commit;

-- ── AFTER RUNNING THIS ─────────────────────────────────────────────────────
--   country=SG      12 rounds · 19,485.25
--   country=MY       1 round  ·    989.53
--   country=SG,MY   12 rounds · 20,474.78   ← was 0 rounds, the whole point
--   no country      12 rounds · 20,474.78
--
-- SG,MY and no-country must agree exactly, because SG and MY are all the
-- countries there are.
