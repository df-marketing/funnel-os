"""
Generate two fake clients that stress what a THIRD and FOURTH client would.

Deliberately unlike Shely and unlike each other:

  acme_fitness   MYR · rounds · TWO markets whose round codes collide
  zenith_saas    USD · weekly cadence · appointments instead of attendance

Every figure is computed here and written into the file's verification block, so
the expected totals are arithmetic rather than a guess.

Deterministic: uuid5 from a fixed namespace, so re-running produces the same
ids and the inserts stay idempotent.
"""
import uuid, random
from datetime import date, timedelta

NS = uuid.UUID("6f1c9b40-0000-4000-8000-000000000000")
uid = lambda s: str(uuid.uuid5(NS, s))
rng = random.Random(20260910)

out = []
w = out.append

# ── ACME FITNESS ───────────────────────────────────────────────────────────
# Four rounds, two markets, and codes that collide ACROSS markets — 0126-01
# exists twice. That is requirement 6 exercised by a client who is not Shely.
ACME_ROUNDS = [
    ("ACME-MY-0126-01", "0126-01", "MY", date(2026, 1, 5),  date(2026, 1, 11)),
    ("ACME-MY-0126-02", "0126-02", "MY", date(2026, 1, 19), date(2026, 1, 25)),
    ("ACME-SG-0126-01", "0126-01", "SG", date(2026, 1, 12), date(2026, 1, 18)),
    ("ACME-SG-0126-02", "0126-02", "SG", date(2026, 1, 26), date(2026, 2, 1)),
]
# ── ZENITH SAAS ────────────────────────────────────────────────────────────
# Weekly, one market, and an appointment stage where Shely has attendance.
ZEN_ROUNDS = [
    (f"ZEN-W{i}", f"W{i}", None,
     date(2026, 2, 2) + timedelta(days=7 * (i - 1)),
     date(2026, 2, 8) + timedelta(days=7 * (i - 1)))
    for i in range(1, 5)
]

ads, contacts, events = [], [], []
tot = {}

def build(client, product, rounds, campaigns, lead_n, mid_n, mid_type, sale_n, price, mid_price):
    spend = impr = clicks = reach = 0
    leads = mids = sales = 0
    revenue = 0.0
    for rid, code, market, d0, d1 in rounds:
        for day in range((d1 - d0).days + 1):
            dt = d0 + timedelta(days=day)
            for camp, aset, ad in campaigns(market):
                sp = round(rng.uniform(40, 130), 2)
                im = rng.randint(1800, 6200)
                ck = rng.randint(30, 140)
                re = rng.randint(1200, 4600)
                ads.append((rid, dt, camp, aset, ad, sp, im, re, ck))
                spend += sp; impr += im; clicks += ck; reach += re
        # people
        n = lead_n
        for i in range(n):
            cid = uid(f"{client}|{rid}|{i}")
            contacts.append((cid, client, f"{client}.{rid.lower()}.{i}@example.test"))
            camp, aset, ad = campaigns(market)[i % len(campaigns(market))]
            events.append((cid, rid, "lead", d0 + timedelta(days=i % 3), None, None, None, camp, aset, ad, "Paid Ads"))
            leads += 1
        for i in range(mid_n):
            cid = uid(f"{client}|{rid}|{i}")
            events.append((cid, rid, mid_type, d1, None, None, rid, None, None, None, None))
            mids += 1
        for i in range(sale_n):
            cid = uid(f"{client}|{rid}|{i}")
            events.append((cid, rid, "sale", d1, "preview", price, rid, None, None, None, None))
            sales += 1; revenue += price
    tot[client] = dict(spend=round(spend, 2), impr=impr, clicks=clicks, reach=reach,
                       leads=leads, mids=mids, sales=sales, revenue=revenue)

acme_camps = lambda m: [
    (f"DF_{m}_Acme_Bootcamp_LP1", "Cold_Fitness25to40", "Static_BeforeAfter"),
    (f"DF_{m}_Acme_Bootcamp_LP2", "Cold_GymGoers",      "Static_CoachTalking"),
]
zen_camps = lambda m: [
    ("GOOG_Zenith_Trial_Brand", "Search_Brand",   "RSA_Headline_A"),
    ("GOOG_Zenith_Trial_Generic", "Search_Generic", "RSA_Headline_B"),
]

build("acme_fitness", "acme-bootcamp", ACME_ROUNDS, acme_camps,
      lead_n=30, mid_n=11, mid_type="attendance", sale_n=3, price=497.0, mid_price=None)
build("zenith_saas", "zenith-trial", ZEN_ROUNDS, zen_camps,
      lead_n=22, mid_n=8, mid_type="appointment", sale_n=3, price=149.0, mid_price=None)

q = lambda v: "null" if v is None else "'" + str(v).replace("'", "''") + "'"

w("""-- TWO MORE CLIENTS, AND NOTHING OF SHELY'S TOUCHED.
--
-- The question is whether this app is actually multi-client or merely has two
-- clients in it. So these two are deliberately unlike Shely and unlike each
-- other, and each one exercises something no existing client does:
--
--   acme_fitness   MYR · rounds · TWO markets whose round codes COLLIDE
--                  0126-01 exists twice, once for MY and once for SG
--   zenith_saas    USD · WEEKLY cadence · an appointment stage where Shely
--                  has attendance, and Google campaigns rather than Meta
--
-- Between them that covers per-client journeys, per-client currency, cadence,
-- market-scoped round codes, a non-core event type, and whether four clients'
-- figures stay apart.
--
-- FIXTURE DATA. It goes on two new client ids and touches nothing that exists.
-- No row of shely's or northsea_supply's is read, updated or deleted by this
-- file, and the undo block at the end removes exactly what it added.
--
-- Safe to re-run. That is not free: ads_performance and events have generated
-- uuid keys, so there is nothing for ON CONFLICT to catch and running twice
-- would simply double them. The block below clears this fixture's own rows
-- first — scoped to these two client ids, so it cannot reach anything else.

begin;

-- ── clear any previous run of THIS fixture, and nothing else ──────────────
delete from events
 where round_id in (select round_id from rounds
                     where client_id in ('acme_fitness','zenith_saas'));
delete from ads_performance
 where round_id in (select round_id from rounds
                     where client_id in ('acme_fitness','zenith_saas'));
delete from contacts where client_id in ('acme_fitness','zenith_saas');
""")

# ── clients: journeys ──────────────────────────────────────────────────────
w("-- ── the journeys. A client EXISTS because it has stages. ────────────────")
w("insert into client_journey_config (client_id, client_name, client_note, stage_order, stage_slug, stage_name, stage_metric, stage_rate_label, compare_dimension, unit_price) values")
rows = []
for o, (slug, name, metric, rate, dim, price) in enumerate([
    ("targeting", "Ad Impressions",    "impressions",       "impressions", "ads_performance.ad_set", None),
    ("ads",       "Ad Clicks",         "clicks",            "CTR",         "ads_performance.ad",     None),
    ("lp",        "Trial Signups",     "leads",             "signup %",    "ads_performance.ad_set", None),
    ("class",     "Bootcamp Attended", "attendance",        "show %",      None,                     None),
    ("preview",   "Bootcamp Sale (RM497)", "preview_purchases", "close %",  None,                    497.0),
], 1):
    rows.append(f"  ('acme_fitness','Acme Fitness','Bootcamp funnel — MY and SG run their own schedules',{o},{q(slug)},{q(name)},{q(metric)},{q(rate)},{q(dim)},{'null' if price is None else price})")
for o, (slug, name, metric, rate, dim, price) in enumerate([
    ("targeting", "Ad Impressions",  "impressions",       "impressions", "ads_performance.ad_set", None),
    ("ads",       "Ad Clicks",       "clicks",            "CTR",         "ads_performance.ad",     None),
    ("lp",        "Free Trials",     "leads",             "trial %",     "ads_performance.ad_set", None),
    ("appointment","Demo Booked",    "appointments",      "booked %",    None,                     None),
    ("preview",   "Paid Plan ($149)","preview_purchases", "convert %",   None,                     149.0),
], 1):
    rows.append(f"  ('zenith_saas','Zenith SaaS','Weekly trial funnel — Google search, demo call before purchase',{o},{q(slug)},{q(name)},{q(metric)},{q(rate)},{q(dim)},{'null' if price is None else price})")
w(",\n".join(rows) + "\non conflict do nothing;\n")

# ── flags, products ────────────────────────────────────────────────────────
w("-- ── currency and the demo flag, so neither shows up as a real account ───")
w("""insert into client_flags (client_id, is_demo, currency) values
  ('acme_fitness', true, 'MYR'),
  ('zenith_saas',  true, 'USD')
on conflict (client_id) do update set is_demo = excluded.is_demo, currency = excluded.currency;
""")

w("-- ── products. `cadence` is what decides By round vs By week. ────────────")
w("""insert into products (product_id, client_id, product_name, product_note, ord, cadence) values
  ('acme-bootcamp','acme_fitness','6-Week Bootcamp','IMAGINARY. Rounds, two markets, RM497 offer.',1,'round'),
  ('zenith-trial','zenith_saas','Zenith Pro Trial','IMAGINARY. Weekly cadence, demo call, $149 plan.',1,'week')
on conflict (product_id) do nothing;
""")

# ── rounds ─────────────────────────────────────────────────────────────────
w("-- ── rounds. acme's codes repeat across markets; that is the point. ──────")
w("insert into rounds (round_id, client_id, product_id, start_date, end_date, code, market) values")
rr = []
for rid, code, market, d0, d1 in ACME_ROUNDS:
    rr.append(f"  ({q(rid)},'acme_fitness','acme-bootcamp',{q(d0)},{q(d1)},{q(code)},{q(market)})")
for rid, code, market, d0, d1 in ZEN_ROUNDS:
    rr.append(f"  ({q(rid)},'zenith_saas','zenith-trial',{q(d0)},{q(d1)},{q(code)},{q(market)})")
w(",\n".join(rr) + "\non conflict (round_id) do nothing;\n")

# ── dimension rules ────────────────────────────────────────────────────────
w("""-- ── the rules that read a campaign name. Per client, as they must be. ───
insert into dimension_values (client_id, target, key, label, ord, note, flags, rules) values
  ('acme_fitness','market','MY','Malaysia',10,'The DF_MY_ prefix.','{}','[{"op":"regex","field":"campaign","value":"^DF_MY_"}]'),
  ('acme_fitness','market','SG','Singapore',20,'The DF_SG_ prefix.','{}','[{"op":"regex","field":"campaign","value":"^DF_SG_"}]'),
  ('acme_fitness','landing_page','LP1','Landing page 1',10,null,'{}','[{"op":"regex","field":"campaign","value":"LP1"}]'),
  ('acme_fitness','landing_page','LP2','Landing page 2',20,null,'{}','[{"op":"regex","field":"campaign","value":"LP2"}]'),
  ('zenith_saas','landing_page','Search','Search landing page',10,null,'{}','[{"op":"contains","field":"campaign","value":"Zenith"}]')
on conflict do nothing;
""")

# ── contacts ───────────────────────────────────────────────────────────────
w("-- ── people ──────────────────────────────────────────────────────────────")
w("insert into contacts (contact_id, client_id, email) values")
w(",\n".join(f"  ({q(c)},{q(cl)},{q(e)})" for c, cl, e in contacts) + "\non conflict (contact_id) do nothing;\n")

# ── ads ────────────────────────────────────────────────────────────────────
w("-- ── spend ───────────────────────────────────────────────────────────────")
w("insert into ads_performance (round_id, date, campaign, ad_set, ad, spend, impressions, reach, clicks, channel) values")
w(",\n".join(
    f"  ({q(r)},{q(d)},{q(c)},{q(s)},{q(a)},{sp},{im},{re},{ck},'meta')" if r.startswith("ACME")
    else f"  ({q(r)},{q(d)},{q(c)},{q(s)},{q(a)},{sp},{im},{re},{ck},'google')"
    for r, d, c, s, a, sp, im, re, ck in ads) + ";\n")

# ── events ─────────────────────────────────────────────────────────────────
w("-- ── what those people did ───────────────────────────────────────────────")
w("insert into events (contact_id, round_id, event_type, event_date, product, amount, lead_round_id, utm_campaign, ad_set, ad, source) values")
w(",\n".join(
    f"  ({q(cid)},{q(rid)},{q(et)},{q(str(dt) + ' 09:00+08')},{q(prod)},"
    f"{'null' if amt is None else amt},{q(lrid)},{q(camp)},{q(aset)},{q(ad)},{q(src)})"
    for cid, rid, et, dt, prod, amt, lrid, camp, aset, ad, src in events) + ";\n")

w("commit;\n")

# ── verification, computed ─────────────────────────────────────────────────
a, z = tot["acme_fitness"], tot["zenith_saas"]
w(f"""-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
-- 1. NOTHING OF SHELY'S MOVED. Check this first; it is the only one that
--    matters if it fails.
--
--      spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
--
--    And northsea_supply: spend 3,550.00 · leads 187 · revenue 13,365.00
--
-- 2. FOUR CLIENTS, EACH WITH ITS OWN FIGURES. Through the app, not the editor:
--
--      acme_fitness   spend {a['spend']:,.2f} · impressions {a['impr']:,} · clicks {a['clicks']:,}
--                     leads {a['leads']} · attendance {a['mids']} · sales {a['sales']} · revenue {a['revenue']:,.2f}
--
--      zenith_saas    spend {z['spend']:,.2f} · impressions {z['impr']:,} · clicks {z['clicks']:,}
--                     leads {z['leads']} · appointments {z['mids']} · sales {z['sales']} · revenue {z['revenue']:,.2f}
--
-- 3. THE CURRENCY IS THE CLIENT'S. acme reads MYR, zenith USD, shely SGD,
--    on the same screen in the same session.
--
-- 4. THE CODES COLLIDE AND BOTH SURVIVE. acme's PERIOD list shows
--    "0126-01 (MY)" and "0126-01 (SG)" on different dates:
--
--      select round_id, code, market, start_date from rounds
--       where client_id = 'acme_fitness' order by code, market;
--
-- 5. THE JOURNEYS DIFFER. acme's fourth stage is Bootcamp Attended;
--    zenith's is Demo Booked, which counts appointments and not attendance.
--    Same engine, two shapes.
--
-- 6. ZENITH IS WEEKLY. Its sidebar offers By week, not By round, because its
--    product says so — no code decides that.
--
-- 7. ISOLATION, if login is on. Grant an account only acme_fitness and it must
--    see one client, and 404 on ?client=zenith_saas.

-- ── UNDO ───────────────────────────────────────────────────────────────────
-- Removes exactly what this added, in dependency order. Touches nothing else.
--
--   begin;
--   delete from events where round_id in (select round_id from rounds where client_id in ('acme_fitness','zenith_saas'));
--   delete from ads_performance where round_id in (select round_id from rounds where client_id in ('acme_fitness','zenith_saas'));
--   delete from contacts where client_id in ('acme_fitness','zenith_saas');
--   delete from rounds where client_id in ('acme_fitness','zenith_saas');
--   delete from dimension_values where client_id in ('acme_fitness','zenith_saas');
--   delete from products where client_id in ('acme_fitness','zenith_saas');
--   delete from client_flags where client_id in ('acme_fitness','zenith_saas');
--   delete from client_journey_config where client_id in ('acme_fitness','zenith_saas');
--   commit;
--   select fo_refresh_lookups();
""")

w("""
-- ── AFTER RUNNING, REFRESH THE CAMPAIGN LOOKUP ─────────────────────────────
-- These campaigns are new, and the lookup is a materialised view. Until this
-- runs they resolve to no market and no landing page.

select fo_refresh_lookups();
""")

path = "/home/pewds/Desktop/pewdiepie/work/ground-truth-testing/_build/48-two-more-clients.sql"
open(path, "w").write("\n".join(out))
print(f"wrote {path}")
print(f"  ads rows     {len(ads)}")
print(f"  contacts     {len(contacts)}")
print(f"  events       {len(events)}")
print(f"  acme   {a}")
print(f"  zenith {z}")
