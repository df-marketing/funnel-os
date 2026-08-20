-- ═══════════════════════════════════════════════════════════════════════════
-- 0026 — a campaign runs by week or by round, and that is a property of the
-- thing being sold, not a decision the app gets to make once.
--
-- 0025 built the week cut, and then the By week TAB was removed on the grounds
-- that Shely runs in rounds and every one of her weeks holds exactly one round.
-- Both halves of that were true and the conclusion was still wrong: deleting
-- the tab moved a per-client fact into the source code, where the next client
-- cannot change it. A workshop that runs in rounds and an evergreen funnel that
-- runs continuously are both normal, and one of them has no rounds to report.
--
-- So cadence becomes data. Each product says how its campaigns run, the sidebar
-- offers the spine that product actually has, and neither answer is compiled in:
--
--   cadence = 'round'  →  By round.  Rounds are the unit; weeks would repeat it.
--   cadence = 'week'   →  By week.   Traffic is continuous; there is no round.
--
-- With no product filter set, a client selling both gets both tabs, because at
-- that point both are true at once.
--
-- Default is 'round' because every product in this database today is one, and a
-- default that matches the existing rows is the only one that changes nothing.
--
-- ── AND THE PRODUCT GETS ITS REAL NAME ────────────────────────────────────
-- 0022 seeded it as 'Webinar → offer', which describes the JOURNEY SHAPE, not
-- the product. The thing Shely sells is the Memi AI Workshop — that is the name
-- on the creative, the name the client uses, and the name a supervisor reading
-- the filter will be looking for. 'Webinar → offer' stays as the client_note,
-- where a journey description belongs.
--
-- Changes no metric. Spend stays 2,447.26, leads 313, attendance 40,
-- revenue 5,067.00.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── CADENCE ────────────────────────────────────────────────────────────────
alter table products add column if not exists cadence text not null default 'round';

-- Constrained, because a typo here silently removes a client's only Overview
-- tab — the sidebar would just be missing an entry, with nothing to say why.
alter table products drop constraint if exists products_cadence_check;
alter table products add constraint products_cadence_check
  check (cadence in ('round', 'week'));

-- ── THE PRODUCT'S REAL NAME ────────────────────────────────────────────────
update products
set product_name = 'Memi AI Workshop',
    product_note = 'Live webinar → SGD 297 preview offer → SGD 1,197 middle offer'
where product_id = 'shely-webinar';

-- ── WHAT THE APP READS ─────────────────────────────────────────────────────
-- cadence is appended LAST. `create or replace view` may add columns to the end
-- and may not insert, rename or reorder them — putting it anywhere else fails
-- with "cannot change name of view column", which is how 0022 learned this.
create or replace view v_products as
select
  p.product_id,
  p.client_id,
  p.product_name,
  p.product_note,
  p.ord,
  count(r.round_id)::int as round_count,
  p.cadence
from products p
left join rounds r on r.product_id = p.product_id
group by p.product_id, p.client_id, p.product_name, p.product_note, p.ord, p.cadence
order by p.client_id, p.ord, p.product_name;

grant select on v_products to anon, authenticated;
