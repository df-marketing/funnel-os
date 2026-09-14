# GroundTruth — architecture handover

**For:** whoever is designing GroundStream's schema and workflow.
**From:** Funnel OS / GroundTruth, read off the live database and code on 11 September 2026.

I do not know GroundStream's domain, so this is written as *"here is what GT does, why, and which
decisions transfer"* rather than as a template. The last two sections — what to copy and what not to
— are the ones worth arguing with.

**Scale, so you can calibrate.** 119 migrations · 19 tables · 57 views · 31 functions · 4 clients ·
3,343 events. It is a small database with a lot of reasoning in it, and most of the reasoning is
about *saying what you do not know* rather than about counting.

---

## 1 · What GT is, and what it deliberately is not

GT is a **reporting and attribution** layer. Four exports arrive — ads spend, leads, attendance,
sales — plus Microsoft Clarity scroll curves, and it answers one question in many cuts: **what did
the money do.**

**It is a subset of AcqOS.** Setup and admin screens belong to the parent; GT never grew a client
editor, a funnel builder or a campaign planner. The journey definition arrives by push and GT is
**not** allowed to edit it.

> ⚠️ **The single most useful architectural decision was drawing that line and not crossing it.**
> Every time a feature felt missing, the question was whether it belonged here or upstream, and the
> answer was upstream about half the time.

---

## 2 · The shape — 19 tables in four groups

### 2.1 Identity and structure

| Table | Rows | What it holds |
|---|---|---|
| `contacts` | 1,895 | One row per person: `contact_id, email, phone, client_id`. **Nothing about campaigns lives here, deliberately** — see §6.3. |
| `rounds` | 29 | One campaign cycle: `round_id, client_id, start_date, end_date, product_id, country, market, code`. |
| `round_sessions` | 16 | One class inside a round. Strictly 1:1 today; kept because five views read it. |
| `products` | 4 | `product_id, client_id, product_name, cadence` — **`cadence` decides whether the client reports By round or By week.** |
| `client_flags` | 4 | GT's own note on an account: `is_demo, currency, meta_ad_account_id, source_client_id, claimed_at`. |

### 2.2 Facts

| Table | Rows | Notes |
|---|---|---|
| `events` | 3,343 | **Every person-level fact in one table** — leads, attendance, sales, declared stages — discriminated by `event_type`. Carries `lead_round_id`, `attribution_method`, `utm_campaign`, `source`, `ad_set`, `ad`, `variant`, `answers` jsonb. ⚠️ **No `client_id`** — it hangs off the round, which has bitten twice. |
| `ads_performance` | 1,967 | Spend and delivery per day/campaign/ad set/ad, plus `channel` and a `measures` jsonb for figures the fixed columns do not carry. |
| `scroll_runs` / `scroll_depths` | 4 / 80 | Clarity curves. `points` jsonb on the run is the read surface; `scroll_depths` is an audit copy nothing reads. |

### 2.3 Definitions — the layer that makes it multi-client

| Table | Rows | Notes |
|---|---|---|
| `client_journey_config` | 21 | **The stage list.** `stage_order, stage_name, stage_slug, stage_metric, compare_dimension, unit_price`. AcqOS is the only writer. |
| `event_types` | 4 | What a person can *do*. A fourth becomes legal by inserting a row, not by altering a table. |
| `journey_metrics` | 7 | The vocabulary of countable things: `metric, metric_key, source ('ads'|'events'), event_type, is_core, aliases, client_id`. |
| `dimension_values` | 20 | **The rules engine.** See §4 — this is the part most worth stealing. |
| `client_targets` | 0 | Wired, never populated. Honest about it on screen. |

### 2.4 Provenance

| Table | Rows | Notes |
|---|---|---|
| `import_batches` | 13 | Every file: `source, coverage_start, coverage_end, column_map, status, staged_payload, diff_summary`. **The plan is persisted here**, see §5. |
| `unmatched_rows` | 16 | Rows that could not be tied to a person with certainty. Two-way: accept, assign or dismiss. **Never counted, never dropped.** |
| `period_insights` | 2 | A frozen reading of a month or round, plus `attribution_model` and `rule_version` — so an old report can explain itself after the rules change. |

---

## 3 · The read path is one function

Every screen calls **`fo_cut(view, client, …filters)`** and gets `setof jsonb` back, metrics nested
under a single key `m`.

```
fo_cut('v_metrics_by_round', 'shely', p_country => 'SG', p_attribution => 'last_touch')
```

**Filters are transaction-local settings, not SQL predicates.** `fo_cut` does
`set_config('funnel.country', 'SG', true)` and the views call `fo_filter_ok(...)`, which reads them.
That is what lets 57 views share one filter implementation without every view growing a WHERE clause
per dimension.

**Every filter is a SET, comma-separated end to end.** Empty means everything. `country=SG,MY` is a
membership test, not equality — a value, not a set, was a real bug.

**Ratios are blanked, not computed, when a filter makes them meaningless.** Select one channel out
of two and CTR goes blank rather than lying about a denominator. `fo_channel_blind` and
`fo_source_blind` do this centrally.

> **Transferable:** one read function, filters as ambient settings, and a rule that a figure which
> cannot be honestly computed is **blanked rather than approximated**.

---

## 4 · The rules engine — the most reusable idea here

**A rule is a row, not a CASE statement.**

```
dimension_values(client_id, target, key, label, ord, note, flags, rules jsonb)
```

- **`target`** — one of `source · market · landing_page · product · channel`
- **`rules`** — a jsonb array of `{field, op, value}`
- **`field`** — one of four things a lead already carries: `campaign`, `ad_set`, `ad`, `source`
- **`op`** — `contains · not_contains · is · is_not · starts_with · ends_with · is_empty · is_not_empty · one_of · regex`
- **`ord`** — priority. **The first value whose rules match wins**, so the list *is* the algorithm
- **`flags`** — `{catch_all: true}` matches whatever is left; `{none: true}` resolves to NULL, which
  is how "this is not a landing page at all" is said

`fo_resolve(client, target, campaign, ad_set, ad, source)` returns the key. Changing a rule
**restates every past round instantly** — the raw campaign name is stored and the label is derived
at read, so nothing is re-imported.

**Four rules that settled the design:**

1. **Store the raw input, derive the label at read.** The alternative is a re-import every time
   somebody renames a thing.
2. **Rules match only on what a row already carries.** No new capture, no dependency on
   `utm_source`, no "please tag your campaigns differently".
3. **Anything a rule cannot resolve gets its own labelled column** rather than folding into a
   default. Unknown is visible.
4. **An operator nobody implemented must not quietly match everything.** The `else` branch returns
   false.

> ⚠️ **Do not build campaign-name-only matching.** The one dimension that cannot come from the
> campaign name is source — an affiliate arrives with no tracking parameter of its own, and the
> export's own source column is the only honest signal.

---

## 5 · The import workflow — plan and commit are separate

```
1 IMPORT     parse, map columns (remembered per source, breaks loudly)
2 MATCH      exact / auto-resolved / parked
3 ATTRIBUTE  lead_round_id + how it was decided
4 DIFF       new rows, changed rows, restatement warnings
5 COMMIT     written only on approval
```

**Steps 1–4 write nothing.** They produce a plan, which is **persisted on the batch** so the diff
someone approved is the diff that gets applied — not a re-parse that might differ.

**Committing one file discards every other staged plan for that client**, because their matches and
attribution were computed against data that has now changed. This is not hypothetical: drop all four
files, commit in order, and attendance was matched against a still-empty contacts table — every
attendee parked, 0 rows written, nothing saying why.

**Identity matching, in strict order:** email exact → phone exact → plus-stripped → last 8 digits.
**No fuzzy name matching, ever.** A row that cannot be tied to a person with certainty is **parked**,
not guessed — and parked rows hold their revenue rather than losing it.

**Column mapping is remembered per source and breaks loudly** when a header moves, rather than
silently mapping to the wrong field.

> **Transferable:** the plan/commit split, persisting the approved plan, invalidating sibling plans
> on commit, and parking rather than guessing.

---

## 6 · Invariants that cost something to learn

### 6.1 Blank is never zero

**Anywhere in the app.** An organic lead's *spend* does not exist; it is not `0.00`. A client whose
journey has no attendance stage shows `—`, not `0`. Every ratio with no denominator shows `—` and
never `#DIV/0!`.

This is the single most-repeated rule in the codebase and it prevents a whole class of confident
wrong answers.

### 6.2 A total that does not move is not proof

Every fault found in review left the headline `20,474.78` intact while something underneath was
wrong. **Check the distribution, not the sum.**

### 6.3 Put per-event facts on the event, not the person

`ad_set`, `ad` and `utm_campaign` live on `events`, not on `contacts`. Storing them on the person
would collapse May's ad and June's ad into one, and a contact who registers for two rounds is the
normal case, not the edge case.

### 6.4 An atomic unit belongs to exactly one period

A round is the unit a class is sold in and **cannot be split across months.** The bug: windows
matched by *overlap*, so a round crossing a month boundary was counted whole in both. August read
8,933.95 against a true 4,997.27.

**The fix generalises:** give the atomic unit **one anchor day**, and test *containment* rather than
overlap. Disjoint windows then partition the units — adjacent periods add up, nothing is double
counted, nothing is dropped.

### 6.5 Verify through the app's own key, never the admin console

The SQL editor connects as superuser and sees rows the app cannot. That difference produced one
false pass: **zero mismatches in the editor, 44 of 46 broken through the app's key.**

### 6.6 Two error codes can share a status and want opposite things

Two `409`s on the handle-claim endpoint: `handle_taken` means *mint another*;
`source_holds_other` means *stop and use the one you hold*. **Callers must branch on a `code` field,
never on the HTTP status.**

---

## 7 · What I would copy into GroundStream

1. **One read function with ambient filters.** 57 views, one filter implementation.
2. **Rules as rows, with order as priority, and a catch-all that is explicit.**
3. **Store raw, derive at read.** Every renameable label.
4. **Plan/commit split, with the plan persisted.**
5. **Park, never guess.** And parked rows keep their money.
6. **Blank ≠ zero, enforced centrally** rather than per view.
7. **Freeze reports with the ruleset that produced them** (`attribution_model`, `rule_version` on
   `period_insights`). Fixing a view must not silently restate an old report.
8. **`is_demo` on the account**, so seeded data is never mistaken for real.
9. **Provenance pills that say what has never been imported**, rather than showing an empty screen.

---

## 8 · What I would do differently

### 8.1 Put `client_id` on every fact table

`events` has none — it reaches the client through `rounds`. That has cost twice: a screen scanning
nothing because it filtered `events.client_id`, and every client-scoped query needing a join.
**Denormalise it. The write is cheap and it is the most-filtered column in the system.**

### 8.2 Never let a read path and a write path drift

Migration 0092 moved the scroll curve's read surface to `scroll_runs.points`, backfilled it, pointed
the view at it — **and left the importer writing `scroll_depths`.** For weeks every import produced a
run with the right session count and an empty curve. Nothing threw.

It survived 683 tests **because every test asserted the audit table nothing reads.**
**Test the surface the app consumes, not the one that is convenient to assert.**

### 8.3 A view freezes what `SELECT *` meant on the day it was created

`create or replace view v_ads as select r.client_id, a.*, …` then an `ALTER TABLE` adds a column, and
re-running the identical text fails with `42P16`. Worse is when it *succeeds* and shifts every column
after it.

**Either enumerate columns in views, or build the view from `information_schema` at migration time.**
We ended up doing the latter.

### 8.4 Resolve per distinct tuple, not per row

`fo_resolve` is `STABLE` and reads a table. Called per row it ran **4,890 times instead of 52** and
took the app down for an afternoon. **Materialise a lookup over distinct inputs and join it back** —
3,343 event rows have only 88 distinct `(campaign, ad_set, ad, source)` tuples.

### 8.5 Do not put a closed union in front of a dynamic feature

The metric table's rows come from `SPINE`, a hard-coded array with a closed `MetricKey` union. So a
client can declare a custom metric, the importer captures it, the read path carries it — and **no row
is drawn**, because the renderer's type does not admit it. **If a dimension is declared in data, the
renderer must be driven by data too.**

### 8.6 Staleness is how far the data reaches, not when the last file landed

We reported "44 days stale" on a source whose newest data was 8 days old, because the most recent
*import* happened to be an older window. **Use `max(coverage_end)`, not the latest batch's.**

---

## 9 · Open items, so nothing is a surprise

- **Custom ads measures do not render.** §8.5. Deferred by decision — no client needs it.
- **RLS is not enabled across the 57 views.** Access is enforced in the application layer
  (`lib/auth/access.ts`), and `security_invoker` has not been swept. Fine for an internal tool with
  one staff role; **not fine the day a client's browser talks to the database directly.**
- **The read floor is ~850ms** for a 7,300-row database on Supabase free tier, and five concurrent
  reads take 3s. It is instance size, not queries — seven query fixes barely moved it.
- **`client_targets` is empty.** Every "vs target" comparison degrades honestly to "no target set".

---

## 10 · Where to look

| | |
|---|---|
| Read path | `fo_cut` — `supabase/migrations/0068_a_filter_is_a_set.sql` |
| Rules engine | `0073_a_rule_is_a_row_not_a_case_statement.sql`, `lib/funnel/rules.ts` |
| Import pipeline | `lib/import/pipeline.ts` — `planImport` and `commitPlan` |
| Access | `lib/auth/access.ts` |
| The metric spine | `lib/funnel/spine.ts` |
| AcqOS wire | `app/api/integration/*`, and `docs/GU-SYNC-HANDOVER.md` |

**Migration headers are the design record.** Each explains what was wrong, what the ruling is, and
what to check afterwards. They are more useful than this document for any specific decision.
