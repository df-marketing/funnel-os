# Requirements 4 and 6 — build handover

**State:** 9 September 2026, migrations 0001–0093 applied, `origin/main` deployed, 7 of 9
requirements done. **Both of these are buildable now.**

Read `docs/funnel-os-schema-plan.md` for the design and `docs/BUILD-PLAN.md` for the rules.

---

## Neither is blocked. Here is why

**Requirement 4 does not need FWD's answers.** The requirement is a *capability*: "the ads table only
accepts reach, impressions and clicks — another client might need video views, make it definable per
client." Build the mechanism. Whether FWD switches it on is a config row, not a design input.

The one open FWD question — does any stage need a Meta-reported metric — decides whether we *use* it
in week one, not whether we *build* it.

**Requirement 6's key question is already answered**, in the original requirement:

> *"for MY, since we only have 3 classes, maybe it'll be named 0526-01, -02 & -03, even if SG classes
> that are scheduled on different dates already taken the name of 0526-01, -02 & -03"*

**Codes repeat across markets.** That is the whole requirement. And it is a **Shely** requirement, not
an FWD one — FWD is Malaysia-only, always-on. Judge its priority on Shely's needs.

---

## The number

```
spend 20,474.78 · leads 1,889 · attendance 682 · purchases 113
revenue 83,927.00 · ROAS 1.80
```

Requirement 4 must not move any of it. Requirement 6 may move **per-market splits** and must not move
**totals** — see its own section.

Verify through the anon key, never the SQL editor. That distinction has already produced one false
pass.

---

# Requirement 4 — dynamic ads measures

Half of this already works. **The people side has been dynamic since `0048`**: `event_types` holds
what a person can do, `journey_metrics` maps a stage to one, and the push validator
(`fo_unknown_metrics`) refuses a stage naming a measurement nobody declared. Adding "policy issued"
is two rows and no code.

**Confirm that before writing anything.** The gap is only the ads side.

## What to build

| Object | Change |
|---|---|
| `ads_performance.measures` | new `jsonb not null default '{}'` |
| `journey_metrics.aliases` | new `text[]` — header spellings the importer accepts |
| `journey_metrics.client_id` | new nullable `text` — null is global, a value is client-only |
| import column mapping | an unmatched column offers this client's declared measurements, plus ignore |
| read path | merge `measures` into the metrics output beside the four columns |

**Keep `spend`, `impressions`, `reach`, `clicks` as real columns.** Every ratio depends on them and
moving them into jsonb buys nothing.

## Adding a measure, end to end

1. one row in `journey_metrics`: metric `video_views`, source `ads`, aliases `ThruPlays`,
   `Video plays`
2. upload the export — the importer matches the alias and writes into `measures`
3. AcqOS pushes a stage naming `video_views`
4. the row appears in the spine; its rate against the previous stage and its cost-per come free,
   because both are already generic

## Watch

A Meta **custom conversion** is Meta's own count, not a person, so it can never join to a contact.
Keep it in the ads spine. Counting it as a funnel stage double-counts against the CRM's own leads.

## Check after

- totals unchanged
- an ads import with no extra columns behaves exactly as before
- a declared measure with no column in the file stores nothing rather than zero — **absent is not
  zero**, and a measure the export did not carry was not measured

**Estimate:** 1–1½ days.

---

# Requirement 6 — market-scoped round names

MY and SG both get to use `0526-01`, on different dates, while totals still add up.

## The trap that decides the design

`round_id` is the primary key and is referenced from **six** places:

```
ads_performance.round_id
events.round_id
events.lead_round_id
events.close_round_id      (dropped in req 9 — confirm before relying on this)
round_sessions.round_id    on delete cascade
period_insights.round_id
```

**None of them has `ON UPDATE CASCADE`.** So renaming `0526-02` to `SG-0526-02` does not propagate —
it breaks every reference, or fails outright on the foreign key. A rename means updating children
first, in order, inside one transaction, with the constraint temporarily deferred. On live client
data that is the most dangerous thing in this whole plan.

**Do not rename existing rounds.**

## The design that avoids it

Add two columns and a constraint. Leave every existing `round_id` exactly as it is.

| Object | Change |
|---|---|
| `rounds.market` | new nullable `text`. Backfill Shely's twelve to `'SG'`, Northsea's to null |
| `rounds.code` | new `text` — the **display** code, e.g. `0526-01`. Backfill from the existing `round_id` |
| unique | `(client_id, product_id, market, code)` — this is what lets MY and SG both hold `0526-01` |
| `round_id` | **unchanged for existing rows.** New rounds get a scoped id: `MY-0526-01`, the way Northsea already uses `DEMO-W1` |

`round_id` stays an opaque primary key. `code` is what a person reads. Every screen showing a round
name shows `code`; `market` disambiguates when both exist.

## What else has to move

- **`monthOf`** — in `lib/funnel/cuts.ts` and its SQL twin `fo_round_month` — parses `MMYY-NN` out of
  `round_id`. It must read `code` instead, or every prefixed round files under the wrong month.
  There are tests pinning `0826-01` to August and `0926-01` to September; they must keep passing.
- **`roundFromCampaign`** must resolve market **plus** code, not code alone, or
  `DF_MY_..._0526_01` resolves to the Singaporean round.
- **The lead-list resolver** must learn which market a registration list belongs to. The import batch
  knows; a list saying `0526-01` alone does not.
- **The period list** in `lib/funnel/data.ts` builds month buckets from round ids. Same fix as
  `monthOf`.

## The ads resolver is already correct — do not touch it

Order is **market → date → name**:

```ts
const campaignRound  = roundFromCampaign(campaign, rounds);
const market         = countryOf(campaign);
const dateCandidates = rounds.filter(x =>
  (!market || !x.country || x.country.toUpperCase() === market) &&
  x.start_date <= date && date <= x.end_date);
const round = (dateCandidates.length === 1 ? dateCandidates[0] : null) ?? campaignRound;
```

The market narrows so overlapping MY/SG schedules stop being ambiguous. The date decides, because
spend belongs to the round it was spent during. The name is the fallback for a period-level export.

This was inverted to name-first once. Measured on the live account, that re-files **$7,500.26 across
nine rounds** the moment anything is re-imported, while the account total stays 20,474.78 — so
nothing on screen says so. The test `"a date inside a round beats the round the campaign is named
for"` pins it.

**When `rounds.market` exists, point the filter at it** rather than at `rounds.country`, and keep the
precedence identical.

## Check after

- **Totals unchanged: 20,474.78 / 1,889 / 682 / 83,927.** Per-market splits may change; the sum may
  not
- every existing round still resolves — twelve for Shely, six for Northsea
- `0826-01` still files under August and `0926-01` under September
- an ads import and a Meta pull both still land rows in the right round
- create a second `0526-01` under a different market and both survive the unique constraint

## Say what moved

Per-market splits change by definition. Name the figure, the size and the reason **before the client
finds it**.

**Estimate:** 2–3 days, and it is the heaviest thing left.

---

# Adjacent, and needed either way

**Per-client currency.** FWD Malaysia is **MYR** — AcqOS already stores `currency: "RM"` for them.
Funnel OS has none: one schema comment saying *"SGD only for v1"*, and `SGD` written into **31
places** across `lib/funnel/spine.ts`, `lib/funnel/chart.ts`, `components/Shell.tsx`,
`components/RoundAnalysis.tsx` and the import mapping. The AcqOS schema push does not carry currency
either.

One column, one push field, and the 31 labels reading it instead of a literal. **Half a day**, and it
is the only FWD-driven work that cannot turn out to be wasted.

---

# Order

1. **Currency** — half a day, certain, unblocks nothing but is needed regardless
2. **Requirement 4** — 1–1½ days, buildable now, independent of 6
3. **Requirement 6** — 2–3 days, last, heaviest, and the only one allowed to move a figure

---

# Two rules this build has already paid for

**A total that does not move is not proof.** Both faults found in review left `20,474.78` intact
while everything underneath was wrong — one because a new table's row-level security hid its rows
from the app but not from the SQL editor, the other because credit was being re-filed between rounds
that still summed correctly. **Check the distribution, not the sum.**

**Migrations that live only in a database cannot be rolled back.** Eighteen of them once existed on a
single laptop while production ran on them. Push before you run.
