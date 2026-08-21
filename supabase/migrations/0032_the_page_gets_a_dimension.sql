-- ═══════════════════════════════════════════════════════════════════════════
-- 0032 — the landing page becomes something the database can hold.
--
-- Step 3c of the CRO process asks whether a page section changed and whether
-- the section above it affected the one below, and 0029 said plainly that the
-- question could not be answered: "no landing-page dimension exists … that
-- question stays unanswered and the screen says so rather than quietly dropping
-- it." This is that dimension.
--
-- ── WHY IT IS ITS OWN PAIR OF TABLES ───────────────────────────────────────
-- A scroll curve is not an event and it is not a metric. It has no person on
-- it, so it cannot go in `events`; it has no money on it, so it cannot go in
-- `ads_performance`; and its denominator is SESSIONS, which is not a
-- denominator any view in this schema already carries. Forcing it into an
-- existing table would mean one of those three lies.
--
-- Two tables rather than one because the file genuinely has two levels: one
-- export is one measurement of one page on one device over one window, and it
-- carries twenty readings. Repeating the window and the session count on all
-- twenty rows would let them disagree, and the session count is the number
-- every percentage on the curve is a percentage of.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
-- No section names, no per-section conversion, no "the hero cost you 12 leads".
-- Clarity's export is a depth curve and nothing in it knows where a section
-- starts or ends. The app reads the curve against Lead Gen % to bound where the
-- form can be (lib/funnel/scroll.ts) and says where the audience is lost. It
-- does not pretend to know what was at that depth.
--
-- No scroll figures in the metric spine either. Sessions are a different
-- population from clicks — the ad account's clicks are what Lead Gen % divides
-- by, and Clarity sees organic traffic too — so a scroll row inside a column
-- that adds up spend and leads would be summing two different denominators.
-- The comparison happens on the This round screen, where both can be labelled.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. THE IMPORTER GAINS A FIFTH SOURCE ───────────────────────────────────
-- import_batches has carried a four-value check since 0001. A scroll import is
-- a real import — it is staged, previewed, committed and traceable like the
-- others — so it needs to be nameable here or it cannot be recorded at all.
alter table import_batches drop constraint if exists import_batches_source_check;
alter table import_batches add constraint import_batches_source_check
  check (source in ('ads', 'leads', 'attendance', 'sales', 'scroll'));

-- ── 1. ONE EXPORT ──────────────────────────────────────────────────────────
create table if not exists scroll_runs (
  run_id        uuid primary key default gen_random_uuid(),
  client_id     text not null,
  round_id      text not null references rounds (round_id),
  page_label    text,                    -- Clarity's "Project name"
  url_pattern   text,                    -- what it filtered on, kept for audit
  device        text not null default 'all'
                check (device in ('mobile', 'desktop', 'tablet', 'all')),
  /**
   * Clarity's own "Page views" line, recorded and NOT used.
   *
   * It disagrees with the curve's denominator — 60 against 58 on the export
   * this was built from — because a view that never fired a scroll event is a
   * view and is not in the scroll base. Storing both is what makes that
   * checkable later instead of arguable.
   */
  page_views    integer,
  sessions      integer not null check (sessions > 0),
  captured_from date,
  captured_to   date,
  source_file   text,
  imported_at   timestamptz not null default now(),
  import_batch_id uuid references import_batches (batch_id),
  /**
   * One curve per page per device per window. A re-export of the same window
   * replaces rather than doubles — the same rule the ads dedupe key follows,
   * and for the same reason: two copies of one measurement would read as twice
   * the traffic.
   */
  unique (client_id, round_id, device, captured_from, captured_to)
);
create index if not exists idx_scroll_runs_round on scroll_runs (round_id);

-- ── 2. THE READINGS ────────────────────────────────────────────────────────
create table if not exists scroll_depths (
  run_id       uuid not null references scroll_runs (run_id) on delete cascade,
  depth_pct    integer not null check (depth_pct between 0 and 100),
  visitors     integer not null check (visitors >= 0),
  /**
   * Clarity's own drop-off figure. Redundant with visitors ÷ sessions by
   * design: it is the second statement of the denominator, and the importer
   * uses the two together to derive `sessions` rather than trusting page views.
   */
  drop_off_pct numeric(6, 2),
  primary key (run_id, depth_pct)
);

alter table scroll_runs   enable row level security;
alter table scroll_depths enable row level security;
drop policy if exists "demo read" on scroll_runs;
drop policy if exists "demo read" on scroll_depths;
create policy "demo read" on scroll_runs   for select using (true);
create policy "demo read" on scroll_depths for select using (true);
grant select on scroll_runs, scroll_depths to anon, authenticated;

-- ── 3. WHAT THE APP READS ──────────────────────────────────────────────────
-- The run with its curve folded into one jsonb array, so a screen showing three
-- runs makes one request rather than one per run. Ordered by depth inside the
-- array, because a curve out of order is a curve nobody can read.
create or replace view v_scroll_runs as
select
  r.run_id,
  r.client_id,
  r.round_id,
  r.page_label,
  r.device,
  r.sessions,
  r.page_views,
  r.captured_from,
  r.captured_to,
  r.source_file,
  r.imported_at,
  coalesce(
    (select jsonb_agg(
              jsonb_build_object(
                'depth',        d.depth_pct,
                'visitors',     d.visitors,
                'drop_off_pct', d.drop_off_pct
              ) order by d.depth_pct)
     from scroll_depths d where d.run_id = r.run_id),
    '[]'::jsonb
  ) as points
from scroll_runs r
order by r.round_id, r.sessions desc, r.device;

grant select on v_scroll_runs to anon, authenticated;

-- The same data one row per reading, for anything that would rather have rows
-- than an array — a CSV export, a chart, a hand-written check in the SQL editor.
create or replace view v_scroll_curve as
select
  r.client_id,
  r.round_id,
  r.run_id,
  r.device,
  r.sessions,
  d.depth_pct,
  d.visitors,
  d.drop_off_pct,
  -- share of sessions still on the page at this depth
  round(100.0 * d.visitors / r.sessions, 1) as reached_pct
from scroll_runs r
join scroll_depths d on d.run_id = r.run_id
order by r.round_id, r.device, d.depth_pct;

grant select on v_scroll_curve to anon, authenticated;

-- ── 4. NO SEED ─────────────────────────────────────────────────────────────
-- Same rule as client_targets in 0029: a measurement nobody took is not a
-- measurement. The tables ship empty and the This round screen says the
-- landing-page question is unanswered until a real Clarity export is imported.
