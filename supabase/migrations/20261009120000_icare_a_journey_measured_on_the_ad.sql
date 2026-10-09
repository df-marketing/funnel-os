-- FWD i-Care: a customer journey measured entirely on the ad.
--
-- WHY THIS CLIENT NEEDS NO NEW IMPORT.
--
-- Shely's journey is four files, because her funnel happens to people: a lead
-- is a person in GoHighLevel, attendance is a person on a webinar, a sale is a
-- person in a payments export. Four sources, joined on identity.
--
-- i-Care sells online. Every step from the ad to the purchase is a Meta action
-- column on the ad row itself:
--
--   Start Application · Submit Health Info · Submit Personal Info
--   Submit Details Confirmation · Submit Declaration · Checkouts initiated
--   Purchase
--
-- So there is no lead file, no attendance file and no sales file — not missing,
-- absent. ONE ads export is the whole journey. The Ads pane in the Import tab
-- is the entire import for this client.
--
-- WHAT THIS USES, AND WHY IT ALREADY EXISTS.
--
-- 0048 moved the vocabulary of measurements into journey_metrics so a client
-- could declare a measure the app had never heard of. 20260911110000 taught
-- fo_stage_extras to read declared measures from ADS as well as events, and its
-- own header noted that no client declared one at the time. This is the client
-- that one was built for.
--
-- Nothing in the application changes. A declared measure is data.
--
-- SAFE TO RE-RUN. Every insert is on conflict do nothing / do update.

begin;

-- ── 1 · THE MEASURES ───────────────────────────────────────────────────────
-- Scoped to this client. A global declaration would put "Submit Health Info"
-- in Shely's vocabulary too, where it means nothing and would be offered as a
-- stage anyone could pick.
--
-- `aliases` is what matches the export's column heading. Matching strips case,
-- spaces and punctuation, so one spelling covers "Start Application",
-- "start_application" and "START APPLICATION".
--
-- metric_key is what the figure is called inside the metrics object. Short,
-- because it is a key, not a label.
insert into journey_metrics (metric, metric_key, label, source, event_type, product, is_core, seq, aliases, client_id) values
  ('start_application',  'startApp',   'Start Application',           'ads', null, null, false, 40, array['Start Application'],           'icare'),
  ('submit_health',      'health',     'Submit Health Info',          'ads', null, null, false, 41, array['Submit Health Info'],          'icare'),
  ('submit_personal',    'personal',   'Submit Personal Info',        'ads', null, null, false, 42, array['Submit Personal Info'],        'icare'),
  ('submit_confirm',     'confirm',    'Submit Details Confirmation', 'ads', null, null, false, 43, array['Submit Details Confirmation'], 'icare'),
  ('submit_declaration', 'declaration','Submit Declaration',          'ads', null, null, false, 44, array['Submit Declaration'],          'icare'),
  ('checkouts_started',  'checkout',   'Checkouts Initiated',         'ads', null, null, false, 45, array['Checkouts initiated'],         'icare'),
  ('icare_purchase',     'icareBuy',   'Purchase',                    'ads', null, null, false, 46, array['Purchase'],                    'icare')
on conflict (metric) do update
  set aliases = excluded.aliases, label = excluded.label, seq = excluded.seq;

-- ── 2 · THE CLIENT ─────────────────────────────────────────────────────────
-- A client in GroundTruth IS its journey stages — v_clients is built from
-- client_journey_config — so this row is what makes it appear in the switcher.
insert into client_flags (client_id, currency) values ('icare', 'MYR')
on conflict (client_id) do update set currency = excluded.currency;

insert into products (product_id, client_id, product_name) values
  ('icare-insurance', 'icare', 'i-Care')
on conflict (product_id) do nothing;

-- ── 3 · THE JOURNEY ────────────────────────────────────────────────────────
-- Nine stages: the two the ad account always measures, then the seven the
-- client declared above. stage_metric names a metric; it is not a column.
--
-- ⚠️ THE SLUG IS NOT JUST A URL. lib/funnel/cuts.ts gives four of them a fixed
-- meaning — it decides which comparison view a tab reads by matching the slug
-- against hardcoded sets:
--
--     targeting -> compare ad sets          ads -> compare ads
--     lp        -> compare landing pages    class -> compare A/B variants
--     preview, middle -> compare offers
--
-- targeting and ads are right for this client: i-Care runs six ad sets and four
-- creatives, and those are the comparisons worth drawing. The other four are
-- not. i-Care has no landing-page variants, no reminder sequences and no offer
-- split, so a stage slugged `lp` would render a landing-page comparison over
-- data that has none.
--
-- So stages 3-6 are slugged for what they are. Nothing in cuts.ts claims them,
-- and they fall to the default cut — the round-by-round view, which is the one
-- that means something here.
--
-- compare_dimension is ads_performance.ad throughout the funnel, because on
-- this client the creative IS the thing being tested: there is no landing page
-- variant and no sequence to compare instead.
insert into client_journey_config
  (client_id, stage_order, stage_name, stage_slug, stage_metric, compare_dimension, stage_rate_label, client_name, unit_price)
values
  ('icare', 1, 'Ad Impressions',              'targeting',   'impressions',       'ads_performance.ad_set', 'impressions', 'FWD i-Care', null),
  ('icare', 2, 'Outbound Clicks',             'ads',         'clicks',            'ads_performance.ad',     'CTR',         'FWD i-Care', null),
  ('icare', 3, 'Start Application',           'start',       'start_application', 'ads_performance.ad',     'start %',     'FWD i-Care', null),
  ('icare', 4, 'Submit Health Info',          'health',      'submit_health',     'ads_performance.ad',     'health %',    'FWD i-Care', null),
  ('icare', 5, 'Submit Personal Info',        'personal',    'submit_personal',   'ads_performance.ad',     'personal %',  'FWD i-Care', null),
  ('icare', 6, 'Submit Details Confirmation', 'confirm',     'submit_confirm',    'ads_performance.ad',     'confirm %',   'FWD i-Care', null),
  ('icare', 7, 'Submit Declaration',          'declaration', 'submit_declaration','ads_performance.ad',     'declare %',   'FWD i-Care', null),
  ('icare', 8, 'Checkouts Initiated',         'checkout',    'checkouts_started', 'ads_performance.ad',     'checkout %',  'FWD i-Care', null),
  ('icare', 9, 'Purchase',                    'purchase',    'icare_purchase',    'ads_performance.ad',     'buy %',       'FWD i-Care', null)
on conflict (client_id, stage_order) do update
  set stage_name = excluded.stage_name, stage_slug = excluded.stage_slug,
      stage_metric = excluded.stage_metric, compare_dimension = excluded.compare_dimension,
      stage_rate_label = excluded.stage_rate_label, client_name = excluded.client_name;

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. The client exists with nine stages and reads in MYR:
--
--      select stage_order, stage_name, stage_slug, stage_metric
--        from client_journey_config where client_id = 'icare' order by stage_order;
--      select client_id, currency from client_flags where client_id = 'icare';
--
-- 2. The measures are declared and scoped to this client only:
--
--      select metric, metric_key, source, aliases, client_id
--        from journey_metrics where client_id = 'icare' order by seq;
--
--    Shely must be unaffected — her vocabulary is the six core metrics plus the
--    global `appointments`, and none of these:
--
--      select count(*) from journey_metrics
--       where is_core = false and (client_id is null or client_id = 'shely');
--
--    Expect 1.
--
-- 3. THEN, and only then, create the round and import the ads export. Nothing
--    will show until there is a round for the file's dates to land in —
--    Round 1 covers 2026-07-01 → 2026-10-06.
--
-- 4. After importing, the declared measures must reach the strip:
--
--      select fo_stage_extras('v_journey_strip', 'icare');
--
--    Expect a jsonb object keyed 'TOTAL' holding startApp, health, personal,
--    confirm, declaration, checkout and icareBuy. An empty {} means the aliases
--    did not match the export's column headings — compare them before assuming
--    the import failed.
