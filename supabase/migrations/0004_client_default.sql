-- Funnel OS — patch 0004
-- 1. v_clients now orders by how much history a client has, so the app opens on
--    Shely rather than on whichever client name sorts first alphabetically.
-- 2. v_client_prices falls back to the checkout stage price for journeys that
--    have no 'preview' stage (ecommerce), so their Selling Price row isn't blank.
-- Safe to re-run. Nothing else changes.

-- Configured unit prices, one row per client.
-- A journey whose purchase stage is 'checkout' rather than 'preview' (ecommerce)
-- still records its sales as product = 'preview' — the first purchase in the
-- journey — so the checkout price stands in as the preview price for that client.
create or replace view v_client_prices as
select
  client_id,
  coalesce(
    max(unit_price) filter (where stage_slug = 'preview'),
    max(unit_price) filter (where stage_slug = 'checkout')
  ) as preview_price,
  max(unit_price) filter (where stage_slug = 'middle')   as middle_price,
  max(unit_price) filter (where stage_slug = 'checkout') as checkout_price
from client_journey_config
group by client_id;

-- Clients, for the switcher. Derived from the journey config — client is a
-- dimension, and the journey is what makes a client real to this app.
--
-- Ordered by how much history each client has, so the app opens on the account
-- with something to look at rather than on whichever name sorts first.
create or replace view v_clients as
select
  j.client_id,
  min(j.client_name)        as client_name,
  min(j.client_note)        as client_note,
  count(*)                  as stage_count,
  coalesce(r.round_count, 0) as round_count
from client_journey_config j
left join (
  select client_id, count(*) as round_count from rounds group by client_id
) r on r.client_id = j.client_id
group by j.client_id, r.round_count
order by coalesce(r.round_count, 0) desc, j.client_id;


grant select on v_clients, v_client_prices to anon, authenticated;
