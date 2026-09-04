-- ═══════════════════════════════════════════════════════════════════════════
-- 0064 — a round is in a country if it RAN there.
--
-- 0062 moved the country onto the ad row and the lead, where a round that ran
-- two countries can be split instead of dropped. It changed v_ads and v_events.
-- It did not change v_rounds, which still asks rounds.country — and rounds.country
-- is NULL for 0926-01, precisely because that round ran both:
--
--     select MY   →   no rounds at all, so every screen in the app is empty
--     select SG   →   eleven rounds, and September silently missing
--
-- Both readings are wrong and the second is worse, because it looks like an
-- answer. Singapore genuinely spent $2,946.46 in 0926-01 and the round simply
-- was not there.
--
-- The cause is that a NULL country compared to a filter is NULL, which is not
-- true, so the round fails the predicate. This is the same shape as the bug that
-- once deleted all 313 leads, one level up: the row that knows nothing is thrown
-- away rather than asked.
--
-- A round is now in a country when it says so ITSELF, or when any of its ad rows
-- or any of its people name that country. The round is a container; the country
-- lives on what is inside it. Once the round is admitted, v_ads and v_events do
-- the real narrowing per row, so selecting MY inside 0926-01 gives Malaysian
-- spend and Malaysian people, not the whole round.
--
-- Rows naming no country — organic leads, and anyone who arrived without a
-- campaign — are still counted under All and under neither country. That is not
-- a gap; nothing about them says where they were.
--
-- Safe to re-run. No column is added, removed or reordered.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function fo_round_country_ok(p_round_id text, p_round_country text)
returns boolean
language sql
stable
as $$
  with f as (select nullif(current_setting('funnel.country', true), '') as c)
  select
      -- no country chosen: every round qualifies, and the caller skips the test
      f.c is null
      -- the round itself declares one (0061's back-fill, still the fallback)
   or p_round_country = f.c
      -- or it bought traffic there
   or exists (
        select 1 from ads_performance a
         where a.round_id = p_round_id
           and fo_country(a.campaign) = f.c
      )
      -- or somebody in it came from there
   or exists (
        select 1 from events e
         where e.round_id = p_round_id
           and coalesce(e.country, fo_country(e.utm_campaign)) = f.c
      )
  from f;
$$;

grant execute on function fo_round_country_ok(text, text) to anon, authenticated;

comment on function fo_round_country_ok(text, text) is
  'Whether a round belongs in the currently selected country. A round that ran '
  'two countries has no country of its own and is admitted to both; the per-row '
  'filters in v_ads and v_events then narrow what is counted inside it.';

-- ── THE ROUND FILTER ASKS THE ROUND'S CONTENTS ─────────────────────────────
-- Same columns, same order — this only changes which rows come back.
create or replace view v_rounds as
select r.*
from rounds r
where fo_filter_people_ok(
        r.product_id,
        -- Feed the predicate the chosen country when the round qualifies, so it
        -- matches; feed it NULL when it does not, so it fails. With nothing
        -- chosen this is the round's own value and the predicate ignores it.
        case
          when fo_round_country_ok(r.round_id, r.country)
            then coalesce(nullif(current_setting('funnel.country', true), ''), r.country)
        end,
        r.start_date, r.end_date
      );

grant select on v_rounds to anon, authenticated;

commit;
