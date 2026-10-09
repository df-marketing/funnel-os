-- FWD i-Care: three rounds over one window.
--
-- The three exports Henry handed over are not three weeks. All three report
-- 2026-07-01 to 2026-10-06, as PERIOD-LEVEL reports — every row carries the
-- window's first day, not its own day — so the date cannot tell them apart and
-- never could. They are three concurrent experiments, and the campaign name is
-- the only thing that separates them.
--
-- NEEDS 63-two-rounds-may-share-a-week-if-they-do-not-share-a-campaign.sql,
-- which adds rounds.campaigns and the trigger that keeps these sets disjoint.
-- Run that first or this fails on an unknown column.
--
-- Campaign names are copied from the files themselves, not retyped — the
-- importer matches them EXACTLY (trimmed and case-folded, nothing else), so a
-- changed character means that ad's rows warn and do not import.
--
-- THE CODES ANCHOR TO JULY. fo_round_month reads the month out of the CODE and
-- uses it when it falls within the months the round spans, falling back to the
-- start's month otherwise. 0726-xx over 2026-07-01 to 2026-10-06 therefore
-- reports as July. 1026-xx would be equally valid to the function and would
-- file the whole experiment under October — where it ended, not where it ran.
--
-- SAFE TO RE-RUN.

begin;

-- `code` is NOT NULL (20260909072904 made it so when round codes became
-- market-scoped) and carries the same value as round_id on every existing row,
-- which is what app/api/rounds/route.ts writes. Read off a live round rather
-- than off 0001_schema.sql, because the ledger is empty and the schema files
-- are intent.
insert into rounds (round_id, code, client_id, start_date, end_date, product_id, market, campaigns) values
  -- Round 1 — base: 19 rows, MYR 7,424.76, 2 campaigns
  ('0726-01', '0726-01', 'icare', '2026-07-01', '2026-10-06', 'icare-insurance', 'MY', array[
    'FWD_iCareChi_META_MOFU_Sales_2026',
    'FWD_iCareEng_META_MOFU_Sales_2026'
  ]),
  -- Round 2 — single attribution: 84 rows, MYR 11,520.00, 4 campaigns
  ('0726-02', '0726-02', 'icare', '2026-07-01', '2026-10-06', 'icare-insurance', 'MY', array[
    'FWD_iCareChi_META_MOFU_Sales_2026_SingleAttribution',
    'FWD_iCareChi_META_MOFU_Sales_2026_SingleAttribution_PurchaseOptimised',
    'FWD_iCareEng_META_MOFU_Sales_2026_SingleAttribution',
    'FWD_iCareEng_META_MOFU_Sales_2026_SingleAttribution_PurchaseOptimised'
  ]),
  -- Round 3 — age split: 45 rows, MYR 9,001.80, 4 campaigns
  ('0726-03', '0726-03', 'icare', '2026-07-01', '2026-10-06', 'icare-insurance', 'MY', array[
    'FWD_iCareChi_META_MOFU_Sales_2026_40To49',
    'FWD_iCareChi_META_MOFU_Sales_2026_50To60',
    'FWD_iCareEng_META_MOFU_Sales_2026_40To49',
    'FWD_iCareEng_META_MOFU_Sales_2026_50To60'
  ])
on conflict (round_id) do update
  set code = excluded.code,
      start_date = excluded.start_date, end_date = excluded.end_date,
      product_id = excluded.product_id, market = excluded.market,
      campaigns  = excluded.campaigns;

commit;

-- ── CHECK AFTER RUNNING ────────────────────────────────────────────────────
-- 1. Three rounds, one window, 10 campaigns between them and none shared:
--
--      select code, start_date, end_date, market, cardinality(campaigns) as campaigns
--        from rounds where client_id = 'icare' order by code;
--
--    Expect 3 rows and 2 + 4 + 4 = 10 campaigns.
--
-- 2. Nothing is claimed twice — the trigger guarantees it, this proves it:
--
--      select lower(btrim(c)) as campaign, count(*)
--        from rounds, unnest(campaigns) c
--       where client_id = 'icare' group by 1 having count(*) > 1;
--
--    Expect no rows.
--
-- 3. Shely is untouched. Her rounds name no campaigns and never will:
--
--      select count(*) from rounds where client_id = 'shely' and campaigns is not null;
--
--    Expect 0.
