-- THE COUNTRY FILTER IS TIMING OUT.
--
-- Clicking MY or SG on By round or By month now returns "canceling statement
-- due to statement timeout" after ten seconds, in production, on Shely. The
-- filter list still appears — that is a different query with its own fallback —
-- so nothing looks broken until somebody uses it.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- `v_rounds` filters every round through `fo_round_country_pick`, which since
-- the retired-column drop asks a question per round and per chosen country:
--
--     does this round have an ad row or an event whose campaign
--     resolves, through the rules, to this market?
--
-- Both halves join `v_campaign_dimensions`. That view is not a table. It is a
-- DISTINCT over ads_performance joined to rounds, UNIONed with a DISTINCT over
-- events joined to rounds, with `fo_resolve` — the rules engine — evaluated on
-- every campaign it finds. Building it once is the work 0076 was written to do
-- once per read.
--
-- Inside a correlated EXISTS it is not built once. It is rebuilt for every
-- round, for every country in the selection, and `v_rounds` is itself joined by
-- every metric view on the screen. Thirteen rounds and one country is thirteen
-- full passes over both tables with the rules run over every campaign in each.
-- That is the ten seconds.
--
-- The rule is unchanged and stays unchanged: A ROUND IS IN A COUNTRY IF IT RAN
-- THERE, NOT IF IT DECLARED ONE. This only stops asking the same question
-- thirteen times.
--
-- ── ORDER ──────────────────────────────────────────────────────────────────
--
-- Run the whole file. It is one script.
--
-- An earlier draft opened with `vacuum (analyze)`, on the theory that the 1,401
-- event rows updated in migration 20260909094500 left dead tuples that all
-- thirteen passes then read — enough to push a query already near the
-- three-second limit over it with nothing in the plan having changed.
--
-- VACUUM CANNOT RUN HERE. The Supabase SQL editor wraps every statement it
-- sends in a transaction, and VACUUM is not allowed inside one; selecting just
-- those lines does not help, because the wrapper is the editor and not the
-- selection. It needs a psql session against the connection string, and it is
-- not worth one: autovacuum reclaims that space on its own schedule, and the
-- dead tuples were never the real fault — they were at most the last straw on
-- top of it.
--
-- ANALYZE is allowed inside a transaction, and it is the half that changes what
-- the planner does rather than what it reads. It stays.

-- ═══ PART 1 — tell the planner what is actually in the tables ══════════════

analyze events;
analyze ads_performance;

-- ═══ PART 2 — ask once instead of once per round ═══════════════════════════

begin;

/**
 * Which markets a round genuinely ran in, resolved in one pass.
 *
 * The same question `fo_round_country_pick` was asking per round, asked once
 * for every round at the same time. `v_campaign_dimensions` is referenced twice
 * here and not once per round, so the rules engine runs over each distinct
 * campaign once for the whole read instead of once per round per country.
 *
 * A round appears once per market it has evidence for, and not at all when it
 * has none — a round that bought no traffic and drew nobody ran nowhere, which
 * is the correct answer and the one the old code gave.
 */
create or replace view v_round_markets as
select distinct r.round_id, d.market
from rounds r
join ads_performance a on a.round_id = r.round_id
join v_campaign_dimensions d
  on d.client_id = r.client_id
 and d.campaign is not distinct from a.campaign
where d.market is not null
union
select distinct r.round_id, d.market
from rounds r
join events e on e.round_id = r.round_id
join v_campaign_dimensions d
  on d.client_id = r.client_id
 and d.campaign is not distinct from e.utm_campaign
where d.market is not null;

grant select on v_round_markets to anon, authenticated;

comment on view v_round_markets is
  'The markets each round has evidence of having run in, from its ad rows and '
  'its people, resolved through the rules once per read rather than once per '
  'round. Read by fo_round_country_pick.';

/**
 * Unchanged in what it decides. Changed in what it costs.
 *
 * Same three cases in the same order: nothing chosen hands back the round''s
 * own value, a declared country that was chosen wins, and otherwise the first
 * chosen market the round can vouch for. NULL when it can vouch for none, which
 * fails the predicate — correct, the round ran in none of them.
 */
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
    when f.cs is null then p_round_country
    when p_round_country = any(f.cs) then p_round_country
    else (
      select chosen.market
      from unnest(f.cs) as chosen(market)
      where exists (
        select 1 from v_round_markets m
         where m.round_id = p_round_id
           and m.market = chosen.market
      )
      limit 1
    )
  end
  from f;
$$;

grant execute on function fo_round_country_pick(text, text) to anon, authenticated;

commit;

-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
-- Through the anon key, never this editor — the editor is a superuser and sees
-- rows row-level security hides from the app. That difference has already
-- produced one false pass on this schema.
--
-- 1. THE FILTER ANSWERS AT ALL, which is the whole point:
--
--      country=MY   →  4 rounds
--      country=SG   →  12 rounds
--      country=SG,MY→  13 rounds
--
--    A set is a set: choosing both must not return fewer than choosing one.
--
-- 2. THE UNFILTERED TOTAL HAS NOT MOVED:
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
--    A total that does not move is not proof on its own — check the four MY
--    rounds are the same four as before, not merely that there are four.
--
-- 3. THE DEMO ROUNDS STILL RESOLVE NOWHERE. DEMO-MY-0526-01 carries market
--    'MY' and has no ad rows and no people, so it ran in no country and the
--    country filter must not offer it. `market` is the naming scope that lets
--    MY and SG share the code 0526-01; `country` is where a round is evidenced
--    to have run. They are different questions and this keeps them different.
