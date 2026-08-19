-- ═══════════════════════════════════════════════════════════════════════════
-- 0022 — a client sells more than one thing, and buys traffic in more than
-- one place.
--
-- Both dimensions are missing entirely today. Every round belongs to a client
-- and nothing narrower, and every ads row is assumed to be Meta because Meta is
-- the only export anyone has sent. Neither assumption survives a second client.
--
-- This migration adds the two columns and backfills what is already known. It
-- deliberately changes NO metric: every view still reads the same rows, so
-- spend stays 2,447.26, leads stay 313, attendance stays 40 and revenue stays
-- 5,067.00. Wiring the filters is the next step; this one only makes the
-- dimensions exist.
--
-- ── PRODUCT hangs off the round ────────────────────────────────────────────
-- Rounds are the spine: ads point at a round, events point at a round, and both
-- offers are sold inside one. Putting the product on the round means every
-- other table inherits it for free and no existing join changes.
--
-- ── CHANNEL is not SOURCE, and the difference matters ──────────────────────
-- The app already has `source`: Paid Ads, AOAI, AI Community, Organic. That is
-- WHERE THE PERSON CAME FROM. Channel is WHERE THE MONEY WAS SPENT — Meta,
-- Google, TikTok. They are independent: a Paid Ads lead can arrive from either
-- platform, and one platform can produce both paid and organic leads.
--
-- Because the two are easy to confuse, the leads importer's alias list is
-- corrected in the same change: a column headed "channel" in a GoHighLevel
-- export used to be read as the lead's SOURCE. From here it is not read at all
-- rather than read as the wrong thing. Shely's remembered mapping uses
-- `source → source`, so nothing re-maps.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── PRODUCTS ───────────────────────────────────────────────────────────────
-- One client, many products. `ord` fixes the column order in the filter so a
-- product doesn't move sideways between page loads as rows land.
create table if not exists products (
  product_id   text primary key,
  client_id    text not null,
  product_name text not null,
  product_note text,
  ord          int  not null default 1
);

create index if not exists idx_products_client on products (client_id);

alter table products enable row level security;
drop policy if exists "demo read" on products;
create policy "demo read" on products for select using (true);
grant select on products to anon, authenticated;

-- Shely sells one thing today: the webinar that leads to the two offers. Named
-- for what it is rather than "Product 1", so a second one has to be named too.
insert into products (product_id, client_id, product_name, product_note, ord)
values ('shely-webinar', 'shely', 'Webinar → offer',
        'Live class, SGD 297 preview offer, 1,197 middle offer', 1)
on conflict (product_id) do nothing;

-- ── ROUNDS GAIN A PRODUCT ──────────────────────────────────────────────────
alter table rounds add column if not exists product_id text references products(product_id);
create index if not exists idx_rounds_product on rounds (product_id);

update rounds set product_id = 'shely-webinar'
where client_id = 'shely' and product_id is null;

-- ── ADS GAIN A CHANNEL ─────────────────────────────────────────────────────
-- No database default. A default would silently stamp 'meta' on a Google export
-- the day one arrives, which is exactly the kind of quiet wrongness the rest of
-- this app refuses. The importer decides, and says which channel it used.
alter table ads_performance add column if not exists channel text;
create index if not exists idx_ads_channel on ads_performance (channel);

-- Every existing row came out of a Meta export — that is evidenced by the
-- column map on the committed batch, not assumed.
update ads_performance set channel = 'meta' where channel is null;

-- ── CHANNEL REFERENCE ──────────────────────────────────────────────────────
-- Fixed order, same reasoning as v_source_buckets in 0006: a column that
-- appears and disappears as rows land would shove the others sideways.
create or replace view v_channels as
select * from (values
  ('meta',   1, 'Facebook and Instagram'),
  ('google', 2, 'Search, Display and YouTube'),
  ('tiktok', 3, 'TikTok'),
  ('other',  9, 'Anything else')
) as t(channel, ord, note);

grant select on v_channels to anon, authenticated;

-- ── WHAT THE APP READS ─────────────────────────────────────────────────────
-- Products a client actually has, with the round count behind each so the
-- filter can grey out one that has nothing in it yet.
create or replace view v_products as
select
  p.product_id,
  p.client_id,
  p.product_name,
  p.product_note,
  p.ord,
  count(r.round_id)::int as round_count
from products p
left join rounds r on r.product_id = p.product_id
group by p.product_id, p.client_id, p.product_name, p.product_note, p.ord
order by p.client_id, p.ord, p.product_name;

grant select on v_products to anon, authenticated;

-- Channels a client actually has spend in. Same rule: a channel with no rows
-- gets no entry, rather than a column of zeroes that were never measured.
create or replace view v_client_channels as
select
  r.client_id,
  coalesce(a.channel, 'other')     as channel,
  coalesce(c.ord, 9)               as ord,
  c.note,
  count(*)::int                    as ad_rows,
  sum(a.spend)::numeric            as spend
from ads_performance a
join rounds r     on r.round_id = a.round_id
left join v_channels c on c.channel = a.channel
group by r.client_id, coalesce(a.channel, 'other'), coalesce(c.ord, 9), c.note
order by r.client_id, coalesce(c.ord, 9);

grant select on v_client_channels to anon, authenticated;
