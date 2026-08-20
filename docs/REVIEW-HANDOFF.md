# Funnel OS — review handoff

**For a reviewer asked to criticise this app and check it.** Written by the agent that built
sprints 3–6, deliberately including the places I am least sure of. Assume I am wrong somewhere;
the point of this document is to make it cheap to find where.

Last updated after migration `0031`. `main` at the commit that reports the step-7 candidate cap.

---

## 0. Read this first — the database currently contains fake data

An **imaginary second product is loaded in production** to make the Product and Channel filters
testable (one option cannot prove a filter narrows anything). Everything about it is marked:
product `shely-demo-evergreen` / "Evergreen Course (demo)", rounds `DEMO-W1`…`DEMO-W4`, contacts at
`@evergreen.invalid`.

**While it is loaded, every "All products" total is inflated:**

| | spend | leads | attendance | revenue |
|---|---|---|---|---|
| Memi AI Workshop (real) | 2,447.26 | 313 | 40 | 5,067.00 |
| Evergreen (demo) | 2,000.00 | 80 | — | 2,376.00 |
| All products | 4,447.26 | 393 | 40 | 7,443.00 |

Remove it with `~/Downloads/funnel-os-test/demo-product-OFF.sql`; re-add with
`demo-product-ON.sql`. **Any number you check must say which product filter it was under.**

---

## 1. What the app is

A reporting and attribution dashboard for one DriveFunnels client (Shely), to be absorbed into a
larger system (AcqOS) under a CRO tab.

- **Stack** Next.js 15 App Router, React 19, TypeScript strict, plain CSS. Supabase Postgres read
  through PostgREST with the anon key; writes go through server routes with the service role key.
- **Deployed** https://funnel-os-red.vercel.app
- **Commands** `npm run dev` · `build` · `typecheck` · `test:import` (325 tests) · `render:round`
- **Migrations** `supabase/migrations/`, applied by hand in the Supabase SQL editor.
  `ALL.sql` is the full rebuild and is **appended to surgically** — regenerating it has clobbered
  its header before.

### Things that are intentional. Do not report these as defects.

1. **There is no login.** The homepage is the app. This is a stated product decision, not an
   oversight. Do not propose adding auth.
2. **The agent never applies migrations.** The user runs all SQL themselves. A migration existing
   in the repo does not mean it is live.
3. **No setup or admin screens.** Products, targets, prices and journeys are configured by SQL
   because the parent system (AcqOS) owns those screens. Do not propose building them here.
4. **`SUPABASE_SERVICE_ROLE_KEY` is on Vercel only**, deliberately absent from `.env.local`.
5. **Blank is not zero, anywhere.** A dash means nobody measured it. A `0` means it was measured
   and was zero. If you find a place where absence renders as `0`, that **is** a bug — it is the
   single most load-bearing rule in the app.

---

## 2. The invariants I built to, and where each is enforced

Check these are actually true rather than merely claimed. Each has bitten at least once.

| # | Rule | Where |
|---|---|---|
| 1 | **Reach is never summed.** It counts deduplicated people, so rounds' reach is not a month's reach. It is read off the coarsest row present. | every `v_metrics_by_*`, `coalesce(sum(reach) filter (where ad_set is null), sum(reach))` |
| 2 | **Absent ≠ zero** for leads, attendance, sales and spend. | `v_leads_seen` / `v_attendance_seen` / `v_sales_seen` gates, `nullif(x,0)` on every denominator |
| 3 | **ROAS and CPA count only ad-produced revenue**, not everything that happened nearby. | `fo_paid_returns` (0020) overrides four jsonb keys |
| 4 | **A round belongs to the month/week it started in.** Splitting it would put the spend in one column and the class it paid for in the next. | `v_metrics_by_month` / `_by_week` |
| 5 | **Revenue counts on `lead_round_id`; leads and attendance on `round_id`.** A lead who buys at a later class credits spend to the round that produced them and attendance to the class they attended. | `v_metrics_by_round` sales CTE |
| 6 | **A filter must bite before rows are added up.** You cannot average a ROAS back out of a total. | `fo_cut` sets GUCs and reads the view in one transaction |
| 7 | **A failed read is never cached.** `unstable_cache` stores returned values and never thrown ones, so every loader throws on error. | `ok()` in `lib/funnel/data.ts` |
| 8 | **Untracked ads are bucketed, not dropped.** A second GoHighLevel template writes `{{ad.id}}`; those leads are real people. | 0021 (`v_metrics_by_ad`), 0030 (`v_round_assets`) |
| 9 | **A rate on a thin denominator is reported and never ranked.** | `MIN_SAMPLE = 30` in `lib/funnel/analysis.ts` |
| 10 | **No silent caps.** A truncated list says how many it left out. | `candidatesFrom` returns `{ shown, dropped }` |
| 11 | **Every number on the page comes through `fo_cut`.** It is the only place the filter is set. Anything read straight from PostgREST is unfiltered — that is how the journey strip showed 393 leads above a table showing 313 (fixed in `0031`). | `loadMetrics`, `loadStrip`, `loadRoundContext` |

---

## 3. What was built, in order, with what to verify

Migrations 0012–0021 predate this handoff and are already live. Everything below is 0022 onward.

### Step 1 — Product and Channel exist · `0022`

Adds `products`, `rounds.product_id`, `ads_performance.channel`, `v_products`, `v_channels`,
`v_client_channels`. Changes no metric.

- [ ] `ads_performance.channel` has **no database default** — a default would silently stamp
      `'meta'` on the first Google export. Confirm the importer decides and says which it used
      (`normChannel` in `lib/import/pipeline.ts`).
- [ ] The leads importer no longer reads a column headed `channel` as the lead's **source**.
      Source (where the person came from) and channel (where the money was spent) are independent.

### Step 2 — The filters · `0023`, `0024`

`fo_filter_ok` / `fo_filter_people_ok`, `v_ads`, `v_events`, `v_rounds`, and `fo_cut` as the single
read path.

- [ ] **`fo_cut`'s `p_view` is whitelisted, not escaped.** Satisfy yourself the whitelist is
      exhaustive and that `format(%I)` cannot be reached with an unlisted name.
- [ ] Two filter functions exist because one did not work: passing `null` as `p_channel` once
      **deleted all 313 leads** (`null = 'meta'` is NULL, and NULL fails the AND). Check the split
      is still correct — people-side rows must not be filtered by channel.
- [ ] `nullif()` runs **before** the `::date` cast. SQL `OR` does not short-circuit; an empty
      string reaching `::date` raises.
- [ ] Filtering to one round must not leave the other round's column present-but-empty. That was a
      real bug fixed in 0024 via `v_rounds`.

**Verify:** with product = Memi AI Workshop, By round returns exactly `0526-02, 0526-03` and no
`DEMO-*`; totals equal 2,447.26 / 313 / 40 / 5,067.00.

### Step 3 — Sessions, weeks, cadence · `0025`, `0026`

A round holds a list of classes (`round_sessions`), not one date. A round running two formats
reports `(mixed)` rather than filing one class's attendees under the other. **Cadence is a property
of the product** (`products.cadence`), deciding whether the sidebar offers By round or By week.

- [ ] `v_round_labels` returns `(mixed)` when a round's sessions carry different labels. Attendance
      is recorded against the round, not the session, so it cannot be split — check it is not
      silently attributed to one.
- [ ] A database that has not run `0026` returns products with no cadence. `cadencesFor` must fall
      back to `["round"]` and leave the sidebar exactly as it was.
- [ ] Landing on `?view=round` for a week-cadence product must redirect to By week, not render an
      empty table that looks like a broken filter (`resolveSpine`).

**History worth knowing:** I deleted the By week tab entirely, and the user corrected me —
campaigns run by week *or* by round. Deleting it moved a per-client fact into source code. If you
see me making that class of mistake elsewhere, say so.

### Bug fixes found by the demo product · `0027`, `0028`

The imaginary product existed to test filters and immediately exposed two figures the app was
printing as if observed.

- [ ] **Attendance read `0` for a class that never happened.** The gate was client-level ("does
      this client report attendance at all?"), so an evergreen round with no class reported a
      measured zero. Now requires both: the client reports attendance **and** the rounds in the
      bucket held a class.
- [ ] **A channel filter invented ROAS.** Revenue carries no platform, so filtering to Meta
      credited Meta with all of it: meta 1.98, google 2.97, truth 1.19. Ratios now blank —
      **but only when the filter actually removed spend** (more than one channel with spend in the
      current product-and-period scope). Filtering a Meta-only product to Meta keeps them, because
      nothing was taken away.
- [ ] `fo_channel_blind` is `immutable` and takes only `jsonb`. An earlier version read a GUC while
      declared immutable, which the planner was entitled to fold. Check nothing has regressed.

**Verify:** `all products + meta` blanks ROAS; `workshop + meta` keeps ROAS 0.364;
`all + meta, May only` keeps it (only Meta ran in May); `all + meta, June only` blanks it.

### Step 5 — The graph · app-only, no migration

A Table/Graph switch on nine tabs. One plot, two lines, an axis each: ad spend on the left, and on
the right either the objective's own level or its efficiency. `mode`, `objective` and `against` live
in the URL.

- [ ] **A missing value must break the line, not be drawn through.** Every dashboard of this shape
      draws straight across a blank and calls it a trend (`lineRuns` splits at every gap).
- [ ] Two axes, not one, and each series' line, dots, value labels and ticks share one colour.
- [ ] The Total column is **not** plotted — it is not a point on the axis.
- [ ] Integer axes take a ceiling divisible by `TICKS - 1`, or labels drift off their own
      gridlines. This was a real bug: 21 attendees labelled `0/6/13/19/25` against lines at 6.25
      and 12.5.
- [ ] Long ad set names fold at a seam (underscore, space, hyphen, camelCase join) with the full
      name in `<title>`. Check nothing is lost, only folded.

**History:** I first built this as three stacked panels and the user rejected it — they wanted the
Looker shape. Judge the current one on its own merits.

### Step 6 — This round as the CRO process · `0029`, `0030`

Seven sections matching the seven steps of the client's process. `0029` adds `end_date` on
`v_metrics_this_round`, `v_round_assets`, and an **empty** `client_targets`. `0030` buckets Ad IDs
in the asset diff.

- [ ] **Steps 6 and 7 must not assert cause.** Step 6 says "that is a coincidence until you check
      it" and refuses to pair an issue with an upstream change. If you can find anywhere the screen
      states or implies causation, that is the most valuable thing you could report.
- [ ] `client_targets` is empty **on purpose** — "comparisons are against previous months/rounds/
      weeks & target" and this database has never held a target. It is not seeded with a guess.
      Check nothing invents one.
- [ ] Step 3 diffs **share, not amount**. A round that spent twice as much moved every figure and
      redistributed nothing.
- [ ] The landing-page half of step 3 is left **open and labelled**, not dropped. It needs a
      landing-page dimension the schema lacks and a Clarity export covering these dates.
- [ ] Step 7 floors: 10 leads minimum for a CPL-multiple candidate, and an asset that never spent
      two leads' worth is not blamed for producing none. The first real run proposed a creative at
      3.5× the round's CPL **on two leads**, which broke the screen's own stated promise.

**Verify** (product = Memi AI Workshop): This round reads `0526-03`, `finished · ran 5 days`.
Step 3 shows exactly four changes, the largest being
`Static_ContentAtScale_StructuredText 88.5% → 35.4% (-53.1 pts)`. Step 5 lists Leads ▼18.0% and
CPM ▲12.8%, with Preview/Overall ROAS held back as too thin (on 6).

---

## 4. Where I would look first if I were you

Ranked by how likely I think it is that I got it wrong.

1. **The thresholds are all my judgement, not the client's.** `MIN_SAMPLE = 30`,
   `MATERIAL_PCT = 10`, `FLAT_PCT = 2`, `SHARE_SHIFT_PTS = 5`, `MIN_ASSET_LEADS = 10`,
   `MIN_SPEND_MULTIPLE = 2`, `CPL_MULTIPLE = 1.5`, `MAX_CANDIDATES = 6`. Only the 30 has a stated
   source (the mockup's own footer). The rest I picked. They change what the screen calls a problem.
2. **`DENOM.roas = "prevBuy"`** — I decided ROAS's confidence rests on the number of preview sales.
   Arguable: it could be total sales, or spend. It decides when ROAS is "too thin to rank".
3. **`DIRECTION`** in `lib/funnel/analysis.ts` marks spend, reach, frequency, impressions and clicks
   as `neutral`, so they are never called better or worse. Reasonable for spend; less obviously
   right for frequency.
4. **`unstable_cache` keying.** Loaders take object arguments (`FilterKey`, and `loadRoundContext`
   takes `(id, filter)`). Confirm Next actually keys on those and two different filters cannot share
   a cache entry. If they can, filtered screens will show each other's numbers, and it will look
   intermittent.
5. **`fo_cut` runs one extra query per read when a channel is selected** (counting channels in
   scope, with the channel GUC momentarily cleared and restored). Check the restore is unconditional
   and that a `stable` plpgsql function doing `set_config(..., true)` twice is safe under all call
   patterns.
6. **`v_round_assets` full outer join.** Keyed on `(client_id, round_id, kind, name)`. Satisfy
   yourself a name appearing in ads but not events (or the reverse) cannot duplicate a row, and that
   `(unsplit)` and `(ad ids)` cannot collide with a real ad named the same.
7. **Reach on the demo product sums across channels** (meta 4,000 + google 3,000 = 7,000/week). That
   is an overstatement nothing can fix — Meta and Google each deduplicate only their own users — and
   it is documented in `demo-product-ON.sql` rather than rigged to look clean. Check the real
   client's reach is not doing the same thing anywhere.
8. **The whole app is server-rendered with `dynamic = "force-dynamic"`** and caches per loader.
   Vercel's Data Cache outlives deployments; a stale wrong screen once survived a redeploy. The
   Refresh button posts to `/api/revalidate`.

---

## 5. Data problems that are NOT app bugs

Do not report these as defects; they are missing inputs, already escalated.

- **Zoom registration is off.** 169 attendance rows, only 40 identifiable; 129 parked. The unmatched
  queue holds 142 rows and **SGD 0** — nothing is lost, nothing is guessed.
- **`4-sales.csv` is supervisor instruction, not a record.** Dates, products and amounts were given
  as rules ("purchase amount is SGD 297, fixed for everyone"). A real payments export has been
  requested and does not exist.
- **Twelve leads carry an ad ID instead of a name** from a second tracking template. Zero overlap
  with Meta's 72 exported ad IDs, and they produced zero attendance.
- **Ads tab counts 37 attendees where By round counts 40.** Community buyers have no ad set or
  creative, so they appear on every round-cut tab and none cut by ad. Documented, not drift.
- **Clicks are derived arithmetic**, not Meta's Link clicks column, which has been requested.
- **No Clarity data covers any round in this database.** The one export received was labelled
  `0726-01` but contained 18–20 August, mobile only, 125 scroll sessions against 129 page views.
  May returns "no scroll information found" — most likely a URL-regex mismatch (the page is
  `...-webinar-2`) or the project not existing before July.
- **Every source is stale** (28–32 days behind) because only May has been imported.

---

## 6. How to check things yourself

```bash
npm run typecheck && npm run test:import && npm run build
npm run render:round        # This round, against synthetic data, as plain text
```

**Against a throwaway Postgres** (this is how every migration here was verified before the user ran
it):

```bash
podman start fos-w
podman exec -i fos-w psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "drop schema public cascade; create schema public;"
podman exec -i fos-w psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/ALL.sql
```

`ALL.sql` must apply cleanly from scratch, and every individual migration must be safe to re-run on
top of it.

**Against live** (anon key, read-only):

```bash
set -a; . ./.env.local; set +a
curl -s -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/rpc/fo_cut" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_view":"v_metrics_total","p_client":"shely","p_product":"shely-webinar"}'
```

**Reading the rendered page:** strip `<!-- -->` before stripping tags. React's SSR hydration markers
sit between adjacent text nodes, and treating them as whitespace makes correct output look broken —
I reported a pluralisation bug that did not exist for exactly this reason.

---

## 7. What is not done

- **Step 7 of the plan** — reconcile every tab against current numbers, fix what moved, write it up.
- **The Landing page tab** is deliberately parked: its `compare_dimension` is null, no landing-page
  dimension has been decided, and guessing one would put a number on screen nobody chose.
- **Clarity scroll import** — blocked on an export that covers a round in this database.
- **Round × source and This round have no graph.** The first has two dimensions and no honest single
  axis; the second is a comparison, not a trend.
- **No target has ever been set.** The project note has said "no objective is set" since sprint 1,
  and the CRO process asks for one as its third comparison.
