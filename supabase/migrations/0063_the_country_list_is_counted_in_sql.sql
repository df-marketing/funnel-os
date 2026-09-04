-- ═══════════════════════════════════════════════════════════════════════════
-- 0063 — count the countries in the database, not over the wire.
--
-- The filter offered SG and no MY, on a client with $989.53 of MY spend and 247
-- MY leads sitting in the database and answering correctly to fo_cut.
--
-- The list was built by selecting country from v_ads and folding the rows in
-- TypeScript. PostgREST caps a response at 1000 rows; v_ads has 1,832, and
-- every MY row is in 0926-01 — the last round, past the cut. So the fold never
-- saw one.
--
-- A distinct that has to be complete cannot be assembled from a page of rows.
-- This does it where the rows are, the same way v_client_channels already
-- answers the channel list.
--
-- Rounds are counted, not ad rows: "SG · 11 rounds" is the useful label, and
-- one campaign spending a dollar for a day should not read the same as eleven
-- rounds of it.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace view v_client_countries as
with from_ads as (
  select r.client_id, fo_country(a.campaign) as country, a.round_id
  from ads_performance a
  join rounds r on r.round_id = a.round_id
  where fo_country(a.campaign) is not null
),
from_events as (
  select r.client_id, e.country, e.round_id
  from events e
  join rounds r on r.round_id = e.round_id
  where e.country is not null
),
-- a round whose campaigns say nothing still answers, if the round itself does
from_rounds as (
  select client_id, country, round_id from rounds where country is not null
),
all_of_them as (
  select * from from_ads
  union select * from from_events
  union select * from from_rounds
)
select client_id, country, count(distinct round_id)::int as round_count
from all_of_them
group by client_id, country
order by client_id, country;

grant select on v_client_countries to anon, authenticated;

commit;
