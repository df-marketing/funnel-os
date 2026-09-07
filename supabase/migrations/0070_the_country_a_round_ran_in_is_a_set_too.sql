-- ═══════════════════════════════════════════════════════════════════════════
-- 0070 — the country a round ran in is a set too.
--
-- 0068 made every filter a set: one comma-separated string end to end, with the
-- predicates splitting it on ','. It changed the three predicates it knew about.
-- It did not change fo_round_country_ok, which 0064 added separately and which
-- v_rounds calls, so that one still compares the WHOLE string with '=':
--
--     funnel.country = 'SG,MY'
--     'SG'  = 'SG,MY'   → false
--     'MY'  = 'SG,MY'   → false      → no round qualifies → v_rounds is empty
--
-- Selecting both countries therefore empties every view that joins v_rounds,
-- while every view that does not carries on working:
--
--     journey strip   spend 20,474.78 · leads 1,848 · attendance 659
--     By round        0 rows
--     By month        0 rows
--
-- Which is the worst of the available failures. The header stands above the
-- table saying the numbers are there, and the table says there is nothing —
-- one screen making two claims, with no way to tell which is the broken one.
--
-- With only two countries this needs both pressed to show up. It is not an
-- edge case: two members is the smallest set that is not one, and the moment a
-- third country exists any pair does it.
--
-- Split the string, same as everything else. `= any(...)` where it was `=`, and
-- a member matching is the round qualifying.
--
-- Safe to re-run. No signature change, no view redefined, so nothing that calls
-- this has to be touched.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function fo_round_country_ok(p_round_id text, p_round_country text)
returns boolean
language sql
stable
as $$
  with f as (
    -- the selection, split. Empty string and NULL both mean "no country chosen".
    select nullif(
             string_to_array(nullif(current_setting('funnel.country', true), ''), ','),
             '{}'
           ) as cs
  )
  select
      -- nothing chosen: every round qualifies, and the caller skips the test
      f.cs is null
      -- the round itself declares one of them (0061's back-fill, still the fallback)
   or p_round_country = any(f.cs)
      -- or it bought traffic in one of them
   or exists (
        select 1 from ads_performance a
         where a.round_id = p_round_id
           and fo_country(a.campaign) = any(f.cs)
      )
      -- or somebody in it came from one of them
   or exists (
        select 1 from events e
         where e.round_id = p_round_id
           and coalesce(e.country, fo_country(e.utm_campaign)) = any(f.cs)
      )
  from f;
$$;

grant execute on function fo_round_country_ok(text, text) to anon, authenticated;

comment on function fo_round_country_ok(text, text) is
  'Whether a round belongs in the currently selected countries. The selection is '
  'a comma-separated set (0068) and a round qualifies on ANY member. A round that '
  'ran two countries has no country of its own and is admitted to both; the '
  'per-row filters in v_ads and v_events then narrow what is counted inside it.';

commit;

-- ── AFTER RUNNING THIS ─────────────────────────────────────────────────────
-- Both countries selected must agree with no country selected, because SG and MY
-- are all the countries there are:
--
--     By round    12 rows · spend 20,474.78
--     By month     5 rows · May…Sep
--
-- and one country alone must be unchanged: SG 12 rounds / 19,485.25,
-- MY 1 round / 989.53.
