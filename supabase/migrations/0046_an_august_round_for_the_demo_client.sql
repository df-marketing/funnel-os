-- ═══════════════════════════════════════════════════════════════════════════
-- One August round on the demo client, so the loop's date matching is tested
-- against something other than the round it has been re-run against all day.
--
-- Requested by AcqOS: their experiment loop closes a finished campaign by
-- matching it to the Funnel OS round covering the same dates, then asking for
-- that round by id. It has only ever been exercised against 0526-03. A second
-- round, different dates, different client, tests the matching rather than the
-- memory of one case.
--
-- ON northsea_supply AND NOWHERE ELSE. shely is a real client: her figures are
-- the master record, they flow into a frozen monthly report, and nothing in that
-- record would mark an invented number as invented. northsea_supply is already
-- synthetic — every contact is @evergreen.invalid and the client carries is_demo
-- — which is exactly why it is the one that can carry this.
--
-- Shaped to match DEMO-W1..W4 exactly: spend 500, reach 7000, impressions
-- 10,000, clicks 200, 20 leads, 2 preview sales. So the new round is comparable
-- to the four before it rather than being a differently-sized outlier.
--
-- NO ATTENDANCE ROWS, though the request asked for them. northsea_supply's
-- journey is four stages — Targeted views, Ads, Product page, Checkout — with no
-- class in it, and none of DEMO-W1..W4 carries an attendance event either.
-- Inventing one would put a number under a stage this client does not have.
--
-- ADS ARE DAY-LEVEL, ON PURPOSE. The request said a single period-level date
-- would be fine. It would, but dating the rows across the window is strictly
-- more useful: 21–26 August straddles ISO weeks 34 and 35, so this round also
-- exercises 0044's week splitting — 250 of the spend and 11 of the leads land in
-- one week, 250 and 9 in the other. It does not straddle a month, so nothing
-- here tests 0045 and nothing here disturbs it.
--
-- Safe to re-run: every row it writes, it first removes.
--
-- ROLLBACK: run the four deletes at the top of this file on their own.
-- ═══════════════════════════════════════════════════════════════════════════

-- Refuses to run anywhere northsea_supply is not flagged demo. The whole point
-- of this file is that it writes fixture rows, and a fixture row in a real
-- account is the one outcome nobody could unpick later.
do $$
begin
  if not exists (select 1 from client_flags where client_id = 'northsea_supply' and is_demo) then
    raise exception
      'northsea_supply is not flagged as a demo client in this database. Refusing to write fixture rows into an account that may be real. Run 0042 first, or check where you are connected.';
  end if;
end $$;

-- ── Remove anything a previous run left, in foreign-key order ───────────────
delete from events          where round_id = 'DEMO-W9';
delete from ads_performance where round_id = 'DEMO-W9';
delete from contacts
 where client_id = 'northsea_supply'
   and email in (select 'demo+' || i || '@evergreen.invalid' from generate_series(81, 100) i);
delete from rounds          where round_id = 'DEMO-W9';

-- ── The round ───────────────────────────────────────────────────────────────
-- 21–26 August 2026. Real dates on the row, which is the only thing the loop's
-- matching actually needs. session_date stays null: this client runs no class.
insert into rounds (round_id, client_id, start_date, end_date, session_date, session_label, product_id)
values (
  'DEMO-W9', 'northsea_supply', date '2026-08-21', date '2026-08-26', null, null,
  /*
   * Read off this client's own most recent round rather than typed, so it
   * cannot name a product that does not exist here.
   *
   * Not keyed to DEMO-W4, which was the first attempt: production has the four
   * DEMO weeks because they were created by hand, and a database built from
   * ALL.sql has NS-0726-01 and NS-0826-01 instead. That lookup returned null
   * there and would have filed this round under no product at all — invisible
   * to the product filter, and to cadence. Asking the client is the question
   * that has an answer in both.
   */
  (select product_id from rounds
    where client_id = 'northsea_supply' and product_id is not null
    order by start_date desc limit 1)
);

-- ── Ads: two channels, two days ─────────────────────────────────────────────
-- ad_set and ad are null, as on every other demo row — this client's export is
-- campaign-level. Totals match one demo week exactly.
insert into ads_performance (round_id, date, campaign, ad_set, ad, spend, impressions, reach, clicks, channel, import_batch_id)
values
  ('DEMO-W9', date '2026-08-21', 'DEMO — Evergreen (Meta)',   null, null, 150.00, 3000, 2000,  60, 'meta',   null),
  ('DEMO-W9', date '2026-08-21', 'DEMO — Evergreen (Google)', null, null, 100.00, 2000, 1500,  40, 'google', null),
  ('DEMO-W9', date '2026-08-25', 'DEMO — Evergreen (Meta)',   null, null, 150.00, 3000, 2000,  60, 'meta',   null),
  ('DEMO-W9', date '2026-08-25', 'DEMO — Evergreen (Google)', null, null, 100.00, 2000, 1500,  40, 'google', null);

-- ── Twenty people ───────────────────────────────────────────────────────────
-- .invalid is reserved by RFC 2606 and can never be a real domain, so none of
-- these addresses can collide with a person or be mailed by accident.
insert into contacts (contact_id, client_id, email)
select gen_random_uuid(), 'northsea_supply', 'demo+' || i || '@evergreen.invalid'
from generate_series(81, 100) i;

-- ── Their opt-ins, spread across the window ─────────────────────────────────
-- Timestamped in the client's own zone so the day they land on is the day a
-- person would say they opted in — the same rule the importer buckets by.
-- One in four is Organic, matching the 15/5 split on the other demo weeks.
insert into events (
  contact_id, round_id, event_type, event_date, lead_round_id,
  attribution_method, source, match_status, is_lead, refund_amount
)
select
  c.contact_id, 'DEMO-W9', 'lead',
  ((case
      when g.i between 81 and 84 then date '2026-08-21'
      when g.i between 85 and 88 then date '2026-08-22'
      when g.i between 89 and 91 then date '2026-08-23'
      when g.i between 92 and 94 then date '2026-08-24'
      when g.i between 95 and 97 then date '2026-08-25'
      else                            date '2026-08-26'
    end + time '10:00') at time zone 'Asia/Singapore'),
  'DEMO-W9', 'date_window',
  case when g.i % 4 = 0 then 'Organic' else 'Paid Ads' end,
  'demo', true, 0
from generate_series(81, 100) as g(i)
join contacts c
  on c.client_id = 'northsea_supply'
 and c.email = 'demo+' || g.i || '@evergreen.invalid';

-- ── Two purchases ───────────────────────────────────────────────────────────
-- Both from Paid Ads leads deliberately: 0020 counts only what advertising
-- produced, so a sale credited to an Organic lead would leave CPA and ROAS
-- blank and the round would look like it returned nothing.
-- One in each ISO week, so the week cut has revenue on both sides of the split.
insert into events (
  contact_id, round_id, event_type, event_date, lead_round_id,
  source, match_status, product, amount, refund_amount, is_lead
)
select
  c.contact_id, 'DEMO-W9', 'sale',
  ((v.sold_on + time '15:00') at time zone 'Asia/Singapore'),
  'DEMO-W9', 'Paid Ads', 'demo', 'preview', 297.00, 0, true
from (values
  ('demo+82@evergreen.invalid', date '2026-08-22'),   -- ISO week 34
  ('demo+95@evergreen.invalid', date '2026-08-26')    -- ISO week 35
) as v(email, sold_on)
join contacts c on c.client_id = 'northsea_supply' and c.email = v.email;
