# What is left to build — requirements 4 to 9

**For:** whoever finishes this.
**State:** 9 September 2026, migrations **0001–0092 applied**, `origin/main` at `27d1efb`, deployed.
**Tests:** 629 passing.

Requirements **1, 2, 3, 5** and **8** are done and verified against production. This document covers
the rest. Read `docs/funnel-os-schema-plan.md` for the design and `docs/BUILD-PLAN.md` for the rules
that must not be broken.

---

## The number

```
spend 20,474.78 · leads 1,889 · attendance 682 · purchases 113
revenue 83,927.00 · ROAS 1.80
```

Every change below must leave these alone. The only permitted exception is requirement 6, and it is
called out where it happens.

```bash
export $(grep -E '^NEXT_PUBLIC_SUPABASE_(URL|ANON_KEY)=' .env.local | xargs)
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/rpc/fo_cut" -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" -d '{"p_view":"v_metrics_total","p_client":"shely"}'
```

**Verify through the anon key, never the SQL editor.** The editor connects as a superuser and sees
rows the app cannot. This has already produced one false pass: a migration returned zero mismatches
in the editor and 44 out of 46 through the app's key, because a new table had row-level security on
and no policy.

---

## What is already done — do not rebuild it

| | |
|---|---|
| **1 Form answers** | `events.answers` jsonb, `v_form_questions`, `v_form_answer_split` |
| **2 Attribution** | Five models, selectable via `p_attribution`, selector live in the UI |
| **3 Sources** | `dimension_values` + `fo_resolve`; `Previous Paid Ads` retired |
| **5 Clarity** | `scroll_runs.page_key`, `heatmap_path`, `points`, storage bucket |
| **8 Cross-round** | Nothing to build. Two registrations already write two rows |

**Attribution is verified working.** Each round's revenue differs by model and every model sums to
83,927 — credit moves between columns and the total never does. That is the property to protect.

---

## 4 — Dynamic customer journey  ·  DO THIS FIRST

**Promoted from deferred.** A second client (FWD) is being onboarded and this is the gate.

Half of it already works. The **people side is dynamic today**: `event_types` holds what a person can
do and `journey_metrics` maps a stage to one of them, so adding "policy issued" is two rows and no
code. Confirm that before writing anything — it changes how much there is to do.

The **ads side is four fixed columns**: `spend`, `impressions`, `reach`, `clicks`. That is the only
gap.

### Build

| Object | Change |
|---|---|
| `ads_performance.measures` | new `jsonb` column, default `'{}'` |
| `journey_metrics.aliases` | new `text[]` — header spellings the importer should recognise |
| `journey_metrics.client_id` | new nullable `text` — null is global, a value is client-specific |
| import column mapping | an unmatched column offers this client's declared measurements, plus ignore |
| read path | merge `measures` into the metrics output beside the four columns |

**Keep spend, impressions, reach and clicks as real columns.** Every ratio depends on them and moving
them into jsonb buys nothing.

### Adding a measure, end to end

1. one row in `journey_metrics`: metric `video_views`, source `ads`, aliases `ThruPlays`, `Video plays`
2. upload the export — the importer matches the alias and writes into `measures`
3. AcqOS pushes a stage naming `video_views`
4. the row appears in the spine; its rate against the previous stage and its cost-per come free,
   because both are already generic

### Before building, get these from the client

Building this in the abstract risks building the wrong shape.

1. FWD's funnel stages, in order
2. which ads figures their journey names that we do not have
3. Meta, Google, or both — the export columns differ
4. one product or several
5. **do they run in rounds, or always-on** ← the biggest risk

That last one matters more than the ads columns. This app is built around rounds. There is a "By
week" cadence for a continuously-running product, but it has had far less use than the round path.
Confirm it before promising a date.

### Watch

A Meta custom conversion is Meta's own count, not a person, so it can never join to a contact. Keep
it in the ads spine. Counting it as a funnel stage double-counts against the CRM's own leads.

**Estimate:** 1½ days once the answers are in. Independent of everything below.

---

## 6 — Round naming per market  ·  THE HEAVIEST

`round_id` is a global primary key referenced from six tables.

### Build

- `rounds.market`, and a round id scoped by it so MY and SG can both run `0526-01`
- unique on client, product, market, channel and code
- `rounds.country` stays as the hand-set fallback for a round whose campaigns say nothing
- the import resolver has to learn which market a registration list belongs to

### The ads resolver is already fixed — do not re-invert it

The order is **market, then date, then name**, and each step is load-bearing:

```ts
const campaignRound  = roundFromCampaign(campaign, rounds);
const market         = countryOf(campaign);
const dateCandidates = rounds.filter(x =>
  (!market || !x.country || x.country.toUpperCase() === market) &&
  x.start_date <= date && date <= x.end_date);
const round = (dateCandidates.length === 1 ? dateCandidates[0] : null) ?? campaignRound;
```

**The market narrows** — once MY and SG run their own schedules their windows overlap, and asking
"which round covers this day" returns two answers with array order picking the winner. Reading the
`DF_MY_` / `DF_SG_` prefix first makes that unambiguous, because one market's own rounds never
overlap each other.

**The date decides** — spend belongs to the round it was spent during. Campaigns keep running after
their round closes.

**The name is the fallback** — a period-level export dates every row to the window's first day, so no
round contains it.

This was inverted to name-first once. Measured on the live account, that re-files **$7,500.26 across
nine rounds** the moment anything is re-imported — largest single move $2,947.15 out of `0926-01`
into `0826-03` — while the account total stays 20,474.78, so nothing on screen says so. The test
`"a date inside a round beats the round the campaign is named for"` pins it. If it starts failing,
that is the reason.

### This one is allowed to move numbers

Per-market splits change by definition. Totals must not. Say which figure moved, by how much, and why,
**before the client finds it**.

**Estimate:** 2–3 days. Build it last.

---

## 7 — Personalisation, audience as a filter

Mostly done: `fo_cut` accepts `p_audience` and `v_contact_entry` exists. What remains is the UI and
the rule about how it behaves.

- **Filter bar → follows you across tabs.** This reverses the existing "an asset does not follow you
  to another tab" rule. Deliberate — say so on screen rather than letting it surprise somebody.
- **Tab drill-down → stays local.**
- Do not copy `ad_set` / `ad` onto attendance and sale rows. That freezes one attribution model into
  the data. The model resolves them at read.

**Test property:** under every model except even split, each sale lands in exactly one audience column
and the columns sum to the total. Under even split they sum fractionally to the same total.

**Estimate:** half a day.

---

## 9 — Drop `is_lead`, `country`, `close_round_id`

All three still exist on `events`. They were kept deliberately while reports moved across in stages;
that is finished, so they can go.

**`pipeline.ts` still writes `is_lead`.** Remove that line in the same change or the next import
fails on a column that no longer exists. Search for it before writing the migration.

A view column cannot be removed in place, so this rides with a `v_events` rewrite rather than a
migration of its own.

**Check after:** totals unchanged, and an ads import still commits.

**Estimate:** half a day, and it is the cheapest confidence in the list.

---

## Order

1. **4** — blocking a client, and independent of everything else
2. **7** — small, and finishes the personalisation work
3. **9** — cheap cleanup, do it while 4 is waiting on answers
4. **6** — last, heaviest, and allowed to move numbers

---

## Two rules this build has already paid for

**Migrations live only in a database are migrations nobody can roll back.** Eighteen of them existed
on one laptop while production ran on them. If the repo does not describe production, a rollback is
guesswork. Push before you run.

**A total that does not move is not proof.** Both faults found in review — the RLS one and the
resolver one — left `20,474.78` intact while everything underneath it was wrong. Check the
distribution, not the sum.
