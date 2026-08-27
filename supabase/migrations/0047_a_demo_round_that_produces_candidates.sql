-- ═══════════════════════════════════════════════════════════════════════════
-- One demo round whose assets can actually be ranked.
--
-- AcqOS needs a real example of a non-empty candidates.shown rather than
-- guessing its shape — three defects on their side today came from writing code
-- against an imagined payload. Nothing they have can produce one: northsea's
-- rows carry no ad set and no creative, so cut=adset has no columns and cut=ad
-- has only 'Unsplit spend', and there is nothing to rank.
--
-- DEMO-W8, 10–16 August 2026 — a whole ISO week (33), entirely inside August,
-- and finished, so it can be frozen and closed like any other.
--
-- THEIR EXAMPLE FIGURES WOULD NOT HAVE WORKED, which is the useful part of
-- doing this rather than describing it. They proposed 8 / 5 / 1 purchases and
-- asked for numbers "comfortably above your thin floor". The floor is
-- MIN_ASSET_OUTCOME = 10 per asset, so at 8 the best creative is still below it,
-- nothing would be ranked, and tooThin would suppress the lot — the same dead
-- end shely already gives them. So the winner here produces 15 and the two
-- runners-up 10 each.
--
-- WHAT IT IS BUILT TO TRIGGER. candidatesFrom pools both partitions, so the
-- round's own rate is 2,100 / 70 = SGD 30.00 per purchase, and:
--
--   NS_Creative_1   spend  150   buys 15   10.00/buy   the winner, and silent
--   NS_Creative_2   spend  200   buys 10   20.00/buy   unremarkable, silent
--   NS_Creative_3   spend  500   buys 10   50.00/buy   1.7x the round → WATCH
--   NS_Creative_4   spend  200   buys  0        —      spent 6.7x a purchase → CUT
--   NS_Audience_A   spend  600   buys 20   30.00/buy   exactly the round's rate
--   NS_Audience_B   spend  450   buys 15   30.00/buy   exactly the round's rate
--
-- Both audiences clear the floor, so tooThin comes back NULL rather than
-- suppressing anything — which is the condition the request actually needs.
--
-- NOTE THE WINNER IS SILENT. candidatesFrom only ever emits 'cut' and 'watch';
-- the 'keep' kind exists in the type and is never produced. So shown will hold
-- two entries, both negative, and NS_Creative_1 will not be in it. That is a
-- gap between what AcqOS expects and what exists, and it is a code question,
-- not a data one — flagged in the reply rather than papered over here.
--
-- The spend matrix is arranged so both partitions sum to the same 1,050:
--
--            C1    C2    C3    C4  │  total
--   Aud A    90   120   270   120  │    600
--   Aud B    60    80   230    80  │    450
--   ─────────────────────────────────────
--   total   150   200   500   200  │  1,050
--
-- Leads and purchases are split the same way, so no cell asks more people to
-- buy than opted in.
--
-- Purchases attach through v_round_assets' lead_asset join — the person's
-- earliest lead in the round — so every buyer here has a lead in this round
-- carrying the ad set and creative that gets the credit. Creative names are
-- non-numeric on purpose: 0033 folds a numeric ad into '(ad ids)'.
--
-- Safe to re-run. Touches northsea_supply only, and refuses to run if that is
-- not a demo client. Does NOT touch DEMO-W1..W4, AcqOS's regression baseline.
--
-- ONE CONSEQUENCE WORTH KNOWING: this round starts before DEMO-W9, so
-- DEMO-W9's previousId becomes DEMO-W8 rather than DEMO-W4. Unavoidable —
-- a round after W9 could not also be closed today — and arguably better, since
-- the comparison is now against the nearer round.
--
-- ROLLBACK: the four deletes at the top of this file, on their own.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from client_flags where client_id = 'northsea_supply' and is_demo) then
    raise exception
      'northsea_supply is not flagged as a demo client in this database. Refusing to write fixture rows into an account that may be real.';
  end if;
end $$;

-- ── Remove anything a previous run left, in foreign-key order ───────────────
delete from events          where round_id = 'DEMO-W8' or lead_round_id = 'DEMO-W8';
delete from ads_performance where round_id = 'DEMO-W8';
delete from contacts
 where client_id = 'northsea_supply' and email like 'demo+w8-%@evergreen.invalid';
delete from rounds          where round_id = 'DEMO-W8';

-- ── The round ───────────────────────────────────────────────────────────────
insert into rounds (round_id, client_id, start_date, end_date, session_date, session_label, product_id)
values (
  'DEMO-W8', 'northsea_supply', date '2026-08-10', date '2026-08-16', null, null,
  (select product_id from rounds
    where client_id = 'northsea_supply' and product_id is not null
    order by start_date desc limit 1)
);

-- ── Ads, in the three tiers a real Meta export arrives in ───────────────────
-- Ad level carries spend and impressions and no reach or clicks; ad-set level
-- carries reach and clicks; the campaign line carries the one reach figure that
-- is actually deduplicated. Same shape as shely's real export, so this round
-- exercises 0016 rather than sidestepping it.
insert into ads_performance (round_id, date, campaign, ad_set, ad, spend, impressions, reach, clicks, channel, import_batch_id)
values
  -- ad level: spend and impressions only, at a flat SGD 50 CPM
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_A', 'NS_Creative_1',  90.00, 1800, null, null, 'meta', null),
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_A', 'NS_Creative_2', 120.00, 2400, null, null, 'meta', null),
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_A', 'NS_Creative_3', 270.00, 5400, null, null, 'meta', null),
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_A', 'NS_Creative_4', 120.00, 2400, null, null, 'meta', null),
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_B', 'NS_Creative_1',  60.00, 1200, null, null, 'meta', null),
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_B', 'NS_Creative_2',  80.00, 1600, null, null, 'meta', null),
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_B', 'NS_Creative_3', 230.00, 4600, null, null, 'meta', null),
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_B', 'NS_Creative_4',  80.00, 1600, null, null, 'meta', null),
  -- ad-set level: reach and clicks, no spend to double-count
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_A', null, 0.00, null, 8000, 240, 'meta', null),
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', 'NS_Audience_B', null, 0.00, null, 6000, 180, 'meta', null),
  -- campaign level: the only reach figure that is deduplicated across the round
  ('DEMO-W8', date '2026-08-10', 'DEMO — Northsea (Meta)', null,            null, 0.00, null, 12000, null, 'meta', null);

-- ── The people, one per cell of the audience × creative matrix ──────────────
-- Emails encode their cell so the events below can find them again without
-- depending on insertion order.
insert into contacts (contact_id, client_id, email)
select gen_random_uuid(), 'northsea_supply',
       'demo+w8-' || c.aud || c.cre || '-' || g.i || '@evergreen.invalid'
from (values
  ('A', 'C1', 18), ('A', 'C2', 14), ('A', 'C3', 11), ('A', 'C4',  7),
  ('B', 'C1', 12), ('B', 'C2', 11), ('B', 'C3',  9), ('B', 'C4',  5)
) as c(aud, cre, n_leads)
cross join lateral generate_series(1, c.n_leads) as g(i);

-- ── Their opt-ins, each carrying the audience and creative that produced it ─
-- utm_campaign AND ad_set both hold the audience: the adset cut reads the utm,
-- v_round_assets reads ad_set, and a lead that answers one and not the other
-- would appear on one tab and vanish from the next.
insert into events (
  contact_id, round_id, event_type, event_date, lead_round_id,
  attribution_method, utm_campaign, ad_set, ad, source, match_status, is_lead, refund_amount
)
select
  ct.contact_id, 'DEMO-W8', 'lead',
  ((date '2026-08-10' + ((g.i - 1) % 7)) + time '10:00') at time zone 'Asia/Singapore',
  'DEMO-W8', 'utm',
  'NS_Audience_' || c.aud, 'NS_Audience_' || c.aud, 'NS_Creative_' || right(c.cre, 1),
  'Paid Ads', 'demo', true, 0
from (values
  ('A', 'C1', 18), ('A', 'C2', 14), ('A', 'C3', 11), ('A', 'C4',  7),
  ('B', 'C1', 12), ('B', 'C2', 11), ('B', 'C3',  9), ('B', 'C4',  5)
) as c(aud, cre, n_leads)
cross join lateral generate_series(1, c.n_leads) as g(i)
join contacts ct
  on ct.client_id = 'northsea_supply'
 and ct.email = 'demo+w8-' || c.aud || c.cre || '-' || g.i || '@evergreen.invalid';

-- ── The purchases, a subset of those same people ────────────────────────────
-- Credit reaches an asset through the buyer's own lead row, so these are the
-- first n_buys people of each cell and nobody else.
insert into events (
  contact_id, round_id, event_type, event_date, lead_round_id,
  source, match_status, product, amount, refund_amount, is_lead
)
select
  ct.contact_id, 'DEMO-W8', 'sale',
  ((date '2026-08-14' + (g.i % 3)) + time '15:00') at time zone 'Asia/Singapore',
  'DEMO-W8', 'Paid Ads', 'demo', 'preview', 297.00, 0, true
from (values
  ('A', 'C1', 9), ('A', 'C2', 6), ('A', 'C3', 5),
  ('B', 'C1', 6), ('B', 'C2', 4), ('B', 'C3', 5)
) as c(aud, cre, n_buys)
cross join lateral generate_series(1, c.n_buys) as g(i)
join contacts ct
  on ct.client_id = 'northsea_supply'
 and ct.email = 'demo+w8-' || c.aud || c.cre || '-' || g.i || '@evergreen.invalid';
