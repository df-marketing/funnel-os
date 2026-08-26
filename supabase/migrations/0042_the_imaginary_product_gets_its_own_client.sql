-- ═══════════════════════════════════════════════════════════════════════════
-- The imaginary product moves out of a real client's account.
--
-- 'shely-demo-evergreen' carries its own confession in product_note: "IMAGINARY
-- — test data for the Product, Channel and cadence filters." It was put into
-- the live database by hand to exercise those filters and left inside Shely's
-- account, where every unfiltered view added it to her real numbers:
--
--   metric      REAL     IMAGINARY   SHOWN AS 'All'   invented
--   impressions 51,360      40,000           91,360      43.8%
--   clicks         832         800            1,632      49.0%
--   leads          313          80              393      20.4%
--   purchases        9           8               17      47.1%
--   revenue      5,067       2,376            7,443      31.9%
--
-- That is the dashboard's default view, and it is also what the integration
-- endpoints return when no product filter is passed — so AcqOS has been reading
-- the blended figure, and a monthly report built today would put 91,360
-- impressions in front of a client whose real answer is 51,360. June 2026 reads
-- worse still: all four of its rounds are imaginary, so the whole month is
-- invented while presenting itself as Shely's.
--
-- ── What this migration is NOT doing ──────────────────────────────────────
--
-- Not inventing a second client. 0002_seed.sql already defines northsea_supply
-- — four stages, an ecommerce journey, its own rounds — and app/page.tsx has
-- carried copy for its 'product' and 'checkout' tabs since before this file
-- existed. 0001_schema.sql line 26 names it in a comment: "e.g. 'shely',
-- 'northsea_supply'". The live database simply does not have it: someone
-- removed it and added the evergreen fixture inside Shely instead.
--
-- So the journey below is 0002's, copied, not a new design. The one change is
-- the checkout price: the seed says 298.00 and the rows actually arriving sell
-- at 297.00 (2,376 over 8 orders). The price is configuration and has to agree
-- with the money underneath it.
--
-- Not restoring the seed's NS-0726-01 and NS-0826-01 rounds, nor the 466 events
-- and 296 contacts behind them. Production has never held them, and this
-- migration exists to take invented rows OUT of the live database — adding
-- several hundred more in the same breath would be an odd way to do it. The
-- seed still has them for anyone who wants a fuller demo; that is a decision,
-- not a side effect of this one.
--
-- ── What moves ───────────────────────────────────────────────────────────
--   products         1 row  — reassigned and renamed to suit its new owner
--   rounds           4 rows — DEMO-W1..W4
--   contacts        80 rows — only those whose events are ALL on demo rounds
--   events          88 rows — no change needed; they hang off round_id
--   ads_performance  8 rows — no change needed; same reason
--
-- Checked before writing this: no contact appears in both a demo and a real
-- event, no real event references a demo round or the reverse, no demo event
-- carries an import_batch_id, and no round_session, scroll_run or client_target
-- touches a demo round. The two sets do not overlap anywhere.
--
-- Staying with Shely: the 142 unmatched rows and 9 import batches. They came
-- out of her real leads exports; the fixture was never imported.
--
-- Safe to re-run: the inserts take the conflict, and each update is keyed on
-- rows that stop matching once they have moved.
--
-- ROLLBACK: set client_id back to 'shely' on the product, the four DEMO rounds
-- and their 80 contacts; delete the northsea_supply rows from
-- client_journey_config and client_flags; re-run 0004 to restore v_clients.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Which accounts are real, as a fact rather than a guess ─────────────────
-- Kept out of client_journey_config on purpose: AcqOS owns that table and its
-- push deletes every row for a client before re-inserting, so a flag stored
-- there would survive exactly until the next sync. This is Funnel OS's own note
-- about an account and nothing else writes it.
create table if not exists client_flags (
  client_id text primary key,
  is_demo   boolean not null default false,
  note      text
);
alter table client_flags enable row level security;

insert into client_flags (client_id, is_demo, note) values
  ('northsea_supply', true,
   'Fixture account. Holds the imaginary product that exercises the product, channel and weekly-cadence filters. No number under this client describes a real business.')
on conflict (client_id) do update
  set is_demo = excluded.is_demo, note = excluded.note;

-- ── The client, which is its journey ───────────────────────────────────────
-- v_clients is built from client_journey_config, so a client with no stages is
-- not a client. This is 0002's definition of northsea_supply, unchanged apart
-- from the price noted above.
insert into client_journey_config (
  client_id, stage_order, stage_name, compare_dimension,
  client_name, client_note, stage_slug, stage_metric, stage_rate_label, unit_price
) values
  ('northsea_supply', 1, 'Targeted views', 'ads_performance.ad_set',
   'Northsea Supply', 'Ecommerce · 3 stages + targeting · DEMO ACCOUNT',
   'targeting', 'impressions',       'impressions', null),
  ('northsea_supply', 2, 'Ads',            'ads_performance.ad',
   'Northsea Supply', 'Ecommerce · 3 stages + targeting · DEMO ACCOUNT',
   'ads',       'clicks',            'CTR',         null),
  ('northsea_supply', 3, 'Product page',   'ads_performance.ad_set',
   'Northsea Supply', 'Ecommerce · 3 stages + targeting · DEMO ACCOUNT',
   'product',   'leads',             'sessions',    null),
  ('northsea_supply', 4, 'Checkout',       'events.product',
   'Northsea Supply', 'Ecommerce · 3 stages + targeting · DEMO ACCOUNT',
   'checkout',  'preview_purchases', 'complete',    297.00)
on conflict (client_id, stage_order) do nothing;

-- ── The contacts, before the rounds ────────────────────────────────────────
-- Read first, while "which rounds are demo" is still answerable by prefix and
-- before anything else has moved. A contact goes only if EVERY event carrying
-- it sits on a demo round; one real event and it stays with Shely, because a
-- person who appears in both is one person and cannot be in two accounts.
update contacts
   set client_id = 'northsea_supply'
 where client_id = 'shely'
   and contact_id in (
     select contact_id from events
      where contact_id is not null and round_id like 'DEMO-%'
   )
   and contact_id not in (
     select contact_id from events
      where contact_id is not null
        and (round_id is null or round_id not like 'DEMO-%')
   );

-- ── The rounds ─────────────────────────────────────────────────────────────
update rounds
   set client_id = 'northsea_supply'
 where client_id = 'shely'
   and product_id = 'shely-demo-evergreen';

-- ── The product ────────────────────────────────────────────────────────────
-- Renamed as it moves. "Evergreen Course" under a supply company was coherent
-- only while it was hiding in someone else's account.
update products
   set client_id    = 'northsea_supply',
       product_name = 'Weekly Supply Plan (demo)',
       product_note = 'IMAGINARY — the fixture that exercises the product, channel and weekly-cadence filters. Runs weekly, no classes.'
 where product_id = 'shely-demo-evergreen';

-- ── The switcher must not open on the fixtures ─────────────────────────────
-- 0004 ordered clients by round count so the app "opens on the account with
-- something to look at rather than on whichever name sorts first". Round count
-- was standing in for "is a real account", and it stops standing in for it the
-- moment the fixture holds four rounds and Shely holds two — which is what the
-- statements above have just arranged. Left alone, the app would greet everyone
-- with the imaginary client.
--
-- is_demo is APPENDED, never inserted mid-list: the column order of a view is
-- part of its contract here.
create or replace view v_clients as
select
  j.client_id,
  min(j.client_name)         as client_name,
  min(j.client_note)         as client_note,
  count(*)                   as stage_count,
  coalesce(r.round_count, 0) as round_count,
  coalesce(f.is_demo, false) as is_demo
from client_journey_config j
left join (
  select client_id, count(*) as round_count from rounds group by client_id
) r on r.client_id = j.client_id
left join client_flags f on f.client_id = j.client_id
group by j.client_id, r.round_count, f.is_demo
order by
  coalesce(f.is_demo, false),          -- real accounts first, whatever they hold
  coalesce(r.round_count, 0) desc,
  j.client_id;

grant select on client_flags to anon, authenticated, service_role;
grant select on v_clients to anon, authenticated, service_role;
