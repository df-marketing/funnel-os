-- ═══════════════════════════════════════════════════════════════════════════
-- What a client can MEASURE stops being source code.
--
-- The journey is already dynamic in every way except one. How many stages a
-- client has, what they are called, what order they run in, what each breaks
-- down by and what a stage costs are all per client and all arrive by push —
-- which is why Shely's headings changed the moment AcqOS sent a funnel.
--
-- What was never dynamic is the VOCABULARY: six metrics, written into three
-- places that had to agree by hand.
--
--   JOURNEY_METRIC_KEYS   TypeScript — the push validator rejected anything else
--   the CASE in 0031/0003 the journey strip's value and rate
--   events.event_type     check (event_type in ('lead','attendance','sale'))
--
-- So "add Appointments" was never a naming problem. It was a schema change in
-- three files, which is the opposite of dynamic, and it is why SECOM's
-- Appointment and CPQL rows render '—' today.
--
-- This migration makes the vocabulary a table. Declaring a measurement becomes
-- an INSERT.
--
-- PHASE 1 OF 4, and it deliberately changes no number anywhere. It seeds
-- exactly the six that exist, marked core, so every view, every ratio and every
-- frozen payload reads precisely what it read before. What it buys is that a
-- seventh can now be DECLARED and validated; making a declared metric produce
-- figures in every cut is phase 2, the journey strip and diagnosis is phase 3,
-- and importing a new event type is phase 4.
--
-- Shipping the foundation on its own is the point: it is additive, it is
-- reversible, and it cannot move a figure in a report that has already gone to
-- a client.
--
-- ROLLBACK:
--   alter table events drop constraint if exists events_event_type_fk;
--   alter table events add constraint events_event_type_check
--     check (event_type in ('lead','attendance','sale'));
--   drop function if exists fo_unknown_metrics(text[]);
--   drop table if exists journey_metrics;
--   drop table if exists event_types;
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The kinds of thing a person can do ──────────────────────────────────────
-- A table rather than a check constraint, because a check constraint is a
-- schema migration and this needs to be a row. `seq` is only a hint about where
-- the thing usually sits in a funnel; the client's own journey decides the real
-- order, and two clients may run the same events in a different sequence.
create table if not exists event_types (
  event_type text primary key,
  label      text not null,
  seq        integer not null default 100
);

insert into event_types (event_type, label, seq) values
  ('lead',       'Lead',       30),
  ('attendance', 'Attendance', 40),
  ('sale',       'Sale',       60)
on conflict (event_type) do nothing;

-- The constraint becomes a foreign key: the same three values are legal today,
-- and a fourth becomes legal by inserting it rather than by altering a table.
alter table events drop constraint if exists events_event_type_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_event_type_fk' and conrelid = 'events'::regclass
  ) then
    alter table events
      add constraint events_event_type_fk
      foreign key (event_type) references event_types (event_type);
  end if;
end $$;


-- ── The vocabulary of measurements ──────────────────────────────────────────
--
-- One row per thing a journey stage may be measured on.
--
-- `metric` is what a push names. `metric_key` is where the number lives inside
-- the metrics object fo_cut returns — the two differ because the wire is
-- readable and the object is terse, and that mapping was previously a constant
-- in TypeScript that nothing enforced.
--
-- `source` says where the count comes from. 'ads' is a delivery figure off the
-- Meta export and cannot be declared per client; 'events' is a count of people,
-- and that is the half a client can extend.
--
-- `product` exists because 'sale' is one event type carrying two stages. The
-- preview and the middle offer are both sales; only the product tells them
-- apart. A declared metric with a null product counts every event of its type.
create table if not exists journey_metrics (
  metric     text primary key,
  metric_key text not null,
  label      text not null,
  source     text not null check (source in ('ads', 'events')),
  event_type text references event_types (event_type),
  product    text,
  -- Core metrics are the six fo_metrics already computes. They are seeded here
  -- so the vocabulary is complete and queryable, NOT so they can be changed:
  -- their arithmetic lives in fo_metrics and the ratios built on them are named
  -- things with specific denominators, not generic divisions.
  is_core    boolean not null default false,
  seq        integer not null default 100,
  -- A metric off the ads export has no event type; a metric counted from events
  -- must name one, or nothing could count it.
  constraint journey_metrics_source_ok check (
    (source = 'ads'    and event_type is null) or
    (source = 'events' and event_type is not null)
  )
);

insert into journey_metrics (metric, metric_key, label, source, event_type, product, is_core, seq) values
  ('impressions',       'impr',    'Impressions',       'ads',    null,         null,      true, 10),
  ('clicks',            'clicks',  'Clicks',            'ads',    null,         null,      true, 20),
  ('leads',             'leads',   'Leads',             'events', 'lead',       null,      true, 30),
  ('attendance',        'att',     'Attendance',        'events', 'attendance', null,      true, 40),
  ('preview_purchases', 'prevBuy', 'Preview purchases', 'events', 'sale',       'preview', true, 50),
  ('middle_purchases',  'midBuy',  'Middle purchases',  'events', 'sale',       'middle',  true, 60)
on conflict (metric) do nothing;

comment on table journey_metrics is
  'The vocabulary a journey stage may be measured on. The six core rows mirror '
  'fo_metrics and must not be edited; additional rows declare a new measurement, '
  'which a client journey can then name.';


-- ── Does this metric exist? ─────────────────────────────────────────────────
--
-- The same shape as fo_unknown_dimensions, and for the same reason: the
-- validator can say a metric LOOKS like a metric, and only the database can say
-- whether anyone declared it. Returning the unknown ones rather than a boolean
-- lets the caller name the offending stage rather than fail the whole payload
-- with "something was wrong".
create or replace function fo_unknown_metrics(p_metrics text[])
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(distinct m), '{}'::text[])
  from unnest(coalesce(p_metrics, '{}'::text[])) as m
  where m is not null
    and not exists (select 1 from journey_metrics jm where jm.metric = m);
$$;

revoke all on function fo_unknown_metrics(text[]) from public, anon, authenticated;
grant execute on function fo_unknown_metrics(text[]) to service_role;

-- Readable by the app: the journey strip and the integration will both need to
-- ask what a metric means once phase 2 lands.
alter table event_types     enable row level security;
alter table journey_metrics enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'event_types' and policyname = 'demo read') then
    create policy "demo read" on event_types for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'journey_metrics' and policyname = 'demo read') then
    create policy "demo read" on journey_metrics for select using (true);
  end if;
end $$;

grant select on event_types     to anon, authenticated, service_role;
grant select on journey_metrics to anon, authenticated, service_role;
