-- ═══════════════════════════════════════════════════════════════════════════
-- Funnel OS v8 — 7-table schema
-- Source: funnel_os_schema.sql (used as-is), plus RLS at the bottom.
--
-- Hybrid: ads_performance (no person) + unified events (leads/attendance/sales)
-- Currency: SGD only for v1. client_id is a plain scoping value (no clients table).
--
-- Safe to re-run: drops the 7 tables first.
-- ═══════════════════════════════════════════════════════════════════════════

drop table if exists unmatched_rows       cascade;
drop table if exists events               cascade;
drop table if exists ads_performance      cascade;
drop table if exists import_batches       cascade;
drop table if exists rounds               cascade;
drop table if exists contacts             cascade;
drop table if exists client_journey_config cascade;

-- ─────────────────────────────────────────────
-- contacts — who the person is
-- ─────────────────────────────────────────────
create table contacts (
  contact_id  uuid primary key default gen_random_uuid(),
  email       text,                      -- lowercased, trimmed on write
  phone       text,                      -- E.164 on write
  client_id   text not null              -- e.g. 'shely', 'northsea_supply'
);
create index idx_contacts_email on contacts (email);
create index idx_contacts_phone on contacts (phone);
create index idx_contacts_client on contacts (client_id);

-- ─────────────────────────────────────────────
-- rounds — when the campaign ran, when the class happened
-- round_id format: MMYY-CC, e.g. 0826-03 = August 2026, cycle 3
-- NOTE: round_id is a GLOBAL primary key in the supplied schema, so round codes
-- must be unique across clients. Northsea's rounds are prefixed 'NS-'.
-- ─────────────────────────────────────────────
create table rounds (
  round_id      text primary key,
  client_id     text not null,
  start_date    date not null,
  end_date      date not null,
  session_date  date,                    -- 1:1 with round today. If a client needs
  session_label text                     -- 1:many later, split into a sessions table.
);
create index idx_rounds_client on rounds (client_id);

-- ─────────────────────────────────────────────
-- import_batches — source freshness and traceability
-- ─────────────────────────────────────────────
create table import_batches (
  batch_id        uuid primary key default gen_random_uuid(),
  source          text not null check (source in ('ads','leads','attendance','sales')),
  imported_at     timestamptz not null default now(),
  coverage_start  date,
  coverage_end    date,
  row_count       integer,
  column_map      jsonb,                 -- remembered per source; renamed column breaks loudly
  stale_flag      boolean not null default false,
  expected_cadence interval,             -- e.g. '1 day' — drives the stale_flag calc
  client_id       text                   -- ADDED: batches are per-client in a multi-client app
);
create index idx_import_batches_source on import_batches (source);

-- ─────────────────────────────────────────────
-- ads_performance — spend/traffic from Meta, no person attached
-- ─────────────────────────────────────────────
create table ads_performance (
  id              uuid primary key default gen_random_uuid(),
  round_id        text references rounds (round_id),
  date            date not null,
  campaign        text,
  ad_set          text,                  -- audience
  ad              text,                  -- creative
  spend           numeric(12,2) default 0,
  impressions     integer default 0,
  reach           integer default 0,
  clicks          integer default 0,
  import_batch_id uuid references import_batches (batch_id)
);
create index idx_ads_round on ads_performance (round_id);
create index idx_ads_adset on ads_performance (ad_set);
create index idx_ads_ad on ads_performance (ad);

-- ─────────────────────────────────────────────
-- events — unified person-level table: leads, attendance, sales
-- ─────────────────────────────────────────────
create table events (
  event_id            uuid primary key default gen_random_uuid(),
  contact_id          uuid references contacts (contact_id),
  round_id            text references rounds (round_id),   -- opt-in / class / purchase round
  event_type          text not null check (event_type in ('lead','attendance','sale')),
  event_date          timestamptz not null,

  -- Attribution (leads: how the round was determined; sales: which round gets
  -- revenue vs. which class gets closing credit)
  lead_round_id       text references rounds (round_id),
  close_round_id      text references rounds (round_id),   -- most recent attendance before purchase
  attribution_method  text,                                -- 'utm' | 'date_window'
  utm_campaign        text,
  source              text,                                -- 'Paid Ads' | 'Organic' | ...
  match_status        text,

  -- Conversion
  product             text check (product in ('preview','middle')),   -- sales only
  minutes_watched     integer,                                        -- attendance only

  -- Money (sales only) — effective revenue = amount - refund_amount
  amount              numeric(12,2),
  refund_amount       numeric(12,2) default 0,
  refund_date         date,              -- WHEN the refund happened — audit trail,
                                          -- prevents silent historical restatement

  -- Edge case
  is_lead             boolean,           -- false = bought without ever being a lead
                                          -- (counted in revenue, excluded from ROAS)

  import_batch_id     uuid references import_batches (batch_id)
);
create index idx_events_contact on events (contact_id);
create index idx_events_round on events (round_id);
create index idx_events_lead_round on events (lead_round_id);
create index idx_events_close_round on events (close_round_id);
create index idx_events_type on events (event_type);
create index idx_events_source on events (source);
-- ADDED: the metric views filter type+round together on every query
create index idx_events_type_round on events (event_type, round_id);
create index idx_events_type_lead_round on events (event_type, lead_round_id);

-- ─────────────────────────────────────────────
-- unmatched_rows — rows that couldn't be tied to a person with certainty
-- ─────────────────────────────────────────────
create table unmatched_rows (
  row_id          uuid primary key default gen_random_uuid(),
  source          text not null,
  import_batch_id uuid references import_batches (batch_id),
  raw_data        jsonb not null,        -- the original row, untouched

  reason          text check (reason in (
                    'same_person_two_addresses',
                    'phone_format',
                    'name_only',
                    'bought_without_lead'
                  )),

  best_guess      text,
  guess_method    text,
  confidence      text check (confidence in ('high','low','none')),

  revenue_held    numeric(12,2) default 0,  -- tracked separately, not counted in ROAS

  parked_at       timestamptz default now(),
  resolved_at     timestamptz,
  auto_resolved   boolean default false,    -- true = confident match, counted, no review
  client_id       text                      -- ADDED: scoping, same reason as import_batches
);
create index idx_unmatched_batch on unmatched_rows (import_batch_id);
create index idx_unmatched_reason on unmatched_rows (reason);

-- ─────────────────────────────────────────────
-- client_journey_config — journey is data, not code
-- ─────────────────────────────────────────────
create table client_journey_config (
  client_id         text not null,
  stage_order       integer not null,
  stage_name        text not null,
  compare_dimension text,               -- which table.column to GROUP BY for this
                                        -- stage's comparison view
  primary key (client_id, stage_order),

  -- ADDED (display only — the journey drives the nav, so the nav needs labels):
  client_name       text,               -- 'Shely' / 'Northsea Supply'
  client_note       text,               -- 'Webinar → offer · 6 stages'
  stage_slug        text,               -- url/tab key: 'targeting', 'ads', ...
  stage_metric      text,               -- which spine metric the journey card shows
  stage_rate_label  text,               -- caption under the card value

  -- Metrics 12 and 13 (Preview / Middle Selling Price) are "current unit price" —
  -- configuration, not something derivable from sales (actual amounts vary:
  -- instalments, multi-seat). The 7-table schema has nowhere else to put it, and
  -- journey-is-data is the right home, so it lives on the offer's stage row.
  unit_price        numeric(12,2)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — demo-first (CLAUDE.md rule 6: the homepage IS the app, no login wall).
-- Anonymous read only. No anon write: every write goes through a server route.
-- The "Lock it down" sprint replaces these with per-user policies.
-- ═══════════════════════════════════════════════════════════════════════════

alter table contacts              enable row level security;
alter table rounds                enable row level security;
alter table import_batches        enable row level security;
alter table ads_performance       enable row level security;
alter table events                enable row level security;
alter table unmatched_rows        enable row level security;
alter table client_journey_config enable row level security;

create policy "demo read" on contacts              for select using (true);
create policy "demo read" on rounds                for select using (true);
create policy "demo read" on import_batches        for select using (true);
create policy "demo read" on ads_performance       for select using (true);
create policy "demo read" on events                for select using (true);
create policy "demo read" on unmatched_rows        for select using (true);
create policy "demo read" on client_journey_config for select using (true);

-- ─────────────────────────────────────────────
-- Derivation notes (encoded in 0003_views.sql, not here):
--
-- Previous Paid Ads  = lead_round_id <> close_round_id AND source = 'Paid Ads'
--                       (an Organic lead buying later round-mismatch is still Organic)
--
-- close_round_id     = most recent attendance event_date before the sale's event_date,
--                       for the same contact_id
--
-- Blank vs zero      = for cost metrics (spend, CPM, CPC, CPL, CPA, ROAS...), return
--                       NULL when a cut has no ads_performance rows, not 0
--
-- Zero-denom         = for ratio metrics (Attendance %, AOV, ROAS...), use NULLIF(denominator, 0)
--                       so division by zero returns NULL ('—') instead of erroring or showing 0%
-- ─────────────────────────────────────────────
