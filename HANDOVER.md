# Funnel OS — handover

**As of 4 September 2026.** Everything below is verified against production, not remembered.

Live: **https://funnel-os-red.vercel.app** · Repo: `df-marketing/funnel-os` · 515 tests passing

---

## 1. What this is

Funnel OS reports on a webinar funnel: **money in → people → attendance → sales**. It answers
"which ad, audience, page or reminder sequence produced the result" for one client at a time.

It is **reporting and attribution only**. It is a subset of **AcqOS**, which owns setup and admin
screens. Do not build those here.

**It has no login, and that is deliberate.** Missing auth is not a defect to fix.

### The two clients

| Client | What it is |
|---|---|
| `shely` | **Real.** Memi AI (Shely) — real people, real money. Never put test data here. |
| `northsea_supply` | Demo/imaginary product with its own client, so demos never touch real data. |

AcqOS owns `DEMO-W1`–`W4` and `northsea_supply`. **Do not change them.**

---

## 2. Running it

```bash
npm run dev          # next dev --turbopack
npx tsc --noEmit     # typecheck
npm run test:import  # the test suite — 515 tests
npm run build
```

**`npm run lint` is not configured.** Skip it.

Deploy:
```bash
npx vercel deploy --prod --yes --scope df-marketing-s-projects
```

### Two things that will bite you

**Deploy from a clean worktree on `main`.** Production was broken once by deploying whatever
branch happened to be checked out, which shipped half-finished code without its migration. Work
happens in a git worktree on `main`, not in the primary directory.

**Never apply migrations to the live database.** Write `.sql` files; the human runs them in the
Supabase SQL editor. `SUPABASE_SERVICE_ROLE_KEY` and `INTEGRATION_SHARED_KEY` live on Vercel
marked Sensitive, and are not in `.env.local`.

---

## 3. How the data works

### The read path

Everything goes through **one** function:

```
fo_cut(p_view, p_client, p_product, p_channel, p_from, p_to, p_offer, p_country)
```

Metrics come back nested under key `m`. Filters travel as transaction-local `set_config('funnel.*')`
settings, read by two predicates: **`fo_filter_ok`** (ad rows) and **`fo_filter_people_ok`** (people).

**Two predicates, not one nullable one.** `null = 'meta'` is `NULL`, which is not `true` — that
comparison once deleted all 313 leads. The same shape reappeared twice more this week (see §6).

### The import order — it is not a suggestion

```
0 Rounds  →  1 Ads  →  2 Leads  →  3 Attendance  →  4 Sales  →  5 Clear unmatched  →  6 Read
```

Each step reads what the one before it wrote. Ads first because **the ad set is the bridge**: a
lead's ad set is matched against which round's spend produced it.

**Step 0 has no screen.** Rounds are created by SQL insert. That is the one gap in the line.

Nothing lands automatically: drop a file → read the diff → commit. A row that cannot be tied to a
person goes to **Unmatched**, where you name them or dismiss them. **Never guessed, never counted** —
so figures are understated by exactly that queue and never overstated. When it's empty, `By round`
is the answer.

### Identity matching

Email exact → phone exact → plus-stripped → last-8-digits.

**No fuzzy name matching, ever.** Phone is an identity field in sales and attendance, not just
membership.

### Dedupe keys

| | |
|---|---|
| Ads | `round_id \| date \| campaign \| ad_set \| ad` |
| Events | `type \| contact \| round \| day \| product` |

### Rules that must not be broken

- **Blank is never zero.** A blank means "we do not know". A zero means "we counted none".
- **`create or replace view` may only APPEND columns**, never reorder. Callers read positionally.
- **`ALL.sql` is appended to surgically.** Every migration must be safe to re-run.
- **Reach is not additive** (`0016`). It is deduplicated people. Read it off the coarsest row:
  `coalesce(sum(reach) filter (where ad_set is null), sum(reach))`.
- **ROAS and CPA count only what the advertising directly produced** (`0020`) —
  `attribution_bucket in ('Paid Ads','Previous Paid Ads')`, not what happened nearby.
- **A month is the month a round is NAMED for**, not the one it opened in (`0826-01` runs 31 Jul).
- **PostgREST caps every response at 1,000 rows.** An explicit `limit=10000` still returns 1,000.
  Never fold raw rows client-side to build a complete list — aggregate in SQL, or page with
  `fetchAll`. This has caused a silent wrong answer.

---

## 4. What is built

**Journey strip** — Impressions → Landing page clicks → Leads → Attendance → Purchase → Upsell.
Every stage is a tab.

**Filters** — Product · Channel · **Country** · Period (months and rounds) · Asset

**Comparison tabs** — By round · By month · By source · Round × source · Targeting (audience) ·
Creatives (ad) · **Class variant (A/B)** · **Landing pages** · Offers · Sessions

**Every asset tab drills down.** Click an audience, creative, variant or landing page and you get
that one asset **round by round**, as table or graph. The chip beside `Table` / `Graph` takes you
back out.

### The graph

Server-rendered SVG. No chart library, no client JavaScript.

Two axes — spend runs in thousands and cost-per-attendee in tens; sharing one scale would flatten
the second into the floor. Bars are amounts you could add up; the line is a rate you could not.

**Picking an efficiency adds the count inside it.** "Cost per attendance" draws spend, attendance
*and* cost per attendance — which is the three-series view that was asked for:

| Ask | Series | Axis |
|---|---|---|
| 1. Amount Spent | Ads Spent (SGD) | left |
| 2. **The Target Number** | Overall Attendance | left |
| 3. Cost Per Target Number | Cost per attendance (SGD) | right |

**A missing value is a gap.** The line breaks rather than drawing through it. Every dashboard of
this shape draws straight across a blank and calls it a trend.

**A total is never plotted** — drawn beside its own parts it would tower over them.

---

## 5. Where the numbers stand

Verified against production today.

| | |
|---|---|
| Spend | **$20,474.78** |
| Leads | **1,889** |
| Attendance | **682** |
| Purchases | **113** (88 preview + 25 middle) |
| Revenue | **$83,927** |
| ROAS | **1.80** · CPA **$365.62** |
| Unmatched queue | **0** |

**Reconciles:** month spine = round total on all four measures. Every asset drill-down sums to its
parent. Attendance 466/466 and organic leads 247/247 exact against the master sheet. Spend to 48¢
across May–Aug.

### By country

| | Spend | Leads | Attend | Show | Buys | Revenue |
|---|---|---|---|---|---|---|
| All | $20,474.78 | 1,889 | 682 | 36.1% | 113 | $83,927 |
| Singapore | $19,485.25 | 1,601 | 605 | 37.8% | 112 | $83,530 |
| Malaysia | $989.53 | 247 | 54 | 21.9% | **0** | **$0** |

Spend reconciles exactly. 41 leads and 23 attendances name no country — organic people who arrived
through no campaign. Counted under All and under neither country. **That is correct, not a gap.**

---

## 6. Findings worth showing the supervisor

### Malaysia is a pricing question, not a traffic one

September, side by side:

| | 🇲🇾 | 🇸🇬 |
|---|---|---|
| Click rate | **3.28%** | 1.23% |
| Cost per lead | **$4.01** | $28.34 |
| Leads per $100 | **25.0** | 3.5 |
| Cost per attendee | **$18.32** | $113.35 |
| Show rate | 21.9% | **25.0%** |
| Purchases | **0** | 2 |

Malaysia bought 7× more leads per dollar and got them into the room for a sixth of the cost, at a
comparable show rate — then sold nothing. Same webinar, same behaviour, no purchases. That points
at **price**.

**One round is not proof.** 247 leads and zero sales is suggestive. A single price test settles it.

### The WhatsApp reminder A/B measured nothing

| | Leads | Attended | Show |
|---|---|---|---|
| WA Sequence A | 179 | 49 | **27.4%** |
| WA Sequence B | 178 | 48 | **27.0%** |

357 people, and the winner flips between rounds. That is a coin flip.

**Where the data comes from:** the client's own round spreadsheets. Sheet `Registration List`, column
`WA Sequence`, one value per person. There is even a sheet called `Check WA Sequence`. Nothing is
inferred from tags and nothing was invented.

**Every round file has been scanned.** Exactly four have the column — `0726-02`, `0726-03`, `0726-04`,
`0826-01`. The other rounds genuinely do not have it:

- `0526-02/03`, `0626-01/02`, `0726-01` — Registration List present, **no sequence column**
- `0826-02`/`0826-03` — file has only `Leads & Attendance` sheets, **no Registration List at all**
- `0926-01` — single `Sheet1`, **no Registration List**

So for the last three rounds we cannot tell whether a test ran. If they want to know, they need the
proper Registration List exports.

To run a new test — any test, email or WhatsApp — fill that column in the export. The group name is
whatever text is in the cell, so `Email Sequence C` becomes its own arm. **No code change.**

### Landing pages

| | Spend | Leads | CPL | Show | ROAS |
|---|---|---|---|---|---|
| LP1 | $11,853.47 | 738 | $16.06 | **26.8%** | **1.88** |
| LP2 | $3,056.16 | 216 | **$14.15** | 20.4% | 0.66 |

LP2 buys cheaper leads; LP1 buys better ones.

### Audiences

`Cold_CoachesLifeCoaches` has the biggest budget and the worst return (0.92).
`Cold_CourseCreators` has the smallest and the best (2.52).

### Faults in the client's own master sheet

- Summary tab trails its detail tabs by **$8,982** — $1,600 of August pricing hardcoded at 297,
  $1,985 of September buyers, and $5,397 of three uncounted middle buyers
- `0926-01` reads 688 leads — a doubled formula
- Three test accounts in the lead counts: `anis@drivefunnels.com` (×3 rounds),
  `henry@drivefunnels.com`, `mydummysl@gmail.com`

---

## 7. What was fixed today

88 commits. The ones that matter, and why — because each was a wrong number nobody could see.

| Fault | What was actually wrong |
|---|---|
| Revenue with no lead was invisible | Six views gated on `lead_round_id is not null` while the docs claimed it was counted. `0052` |
| Payments file could not introduce a buyer | 4 buyers parked with only "Dismiss" — which discards money — as an exit |
| Lead dated after the sale | $2,094 across 5 people filed in the wrong round |
| Attendance 578 → 790 on re-import | `anon_key` was never stored, so anonymous rows could not be recognised twice. `0054` |
| Leads in the wrong round | People register before ads run; 74 of 97 filed under the previous round. Declared round now outranks the UTM |
| `– Copy` suffix split assets in two | The first fix missed **mojibake** (`â€"`). 103 leads kept the suffix |
| Variants over-counted | Arms credited with attendance from rounds the test never ran in. `0057` |
| Landing pages over-counted | A page claiming rounds it was not used in. `0059` |
| Country was on the round | `0926-01` ran both countries, so its country was null. `0062` moved it per row |
| **MY missing from the filter** | The list was folded from raw rows and **PostgREST capped it at 1,000**. `0063` |
| **Country filter emptied the app** | `v_rounds` still asked `rounds.country`. MY → no rounds; SG → September silently gone. `0064` |
| **September had no month** | Rounds filed by when they opened, not by the month they are named for |
| **A known zero read as blank** | The "has a sales file been imported" gate read filtered data, so a filter that removed every sale reported "unknown". Malaysia's zero — the whole finding — was invisible. `0065` |
| Empty tab said nothing useful | "No columns under the current filter" reads identically to "broken". It now names the rounds the data is in |

**Three of these are the same mistake**: something that knew nothing was thrown away instead of
being asked. Watch for it.

---

## 8. Open work

**Data, waiting on the client**

1. **Registration Lists for `0826-02` and `0826-03`** — the last +14 / +20 on leads, and the only
   way to know whether a sequence test ran in those rounds
2. **Three test accounts** left in deliberately so the lead match stays exact — strip them when he does
3. **Attendance appears to over-count by ~12**, concentrated in `0826-02`/`0826-03`. Believed to be
   his sheet being unfinished rather than our count, but unproven

**Build**

4. **Rounds have no screen.** Step 0 is a SQL insert. This is the one gap in the straight line
5. **Meta "Pull now"** — on hold. Brief at `BRIEF-meta-pull-now-funnel-os.md`. Endpoint protection is
   answered (`INTEGRATION_SHARED_KEY`); **round creation is not** — it depends on (4)
6. **Per-creative frequency is not obtainable.** Meta's export cannot give it: reach is deduplicated
   people and does not sum. `0926-01` sums to 91,133 against a true 52,430. **Impressions-per-lead**
   is the honest substitute and can be added as a column and a graph line — roughly an hour

**Housekeeping**

7. `ground-truth-testing/` contains **real client contact data** and is not a git repo.
   **It must never go to a public remote.**

---

## 9. Timeline

Estimates, from a codebase that currently passes 515 tests with production green.

| | Work | Estimate | Blocked by |
|---|---|---|---|
| A | Impressions-per-lead as the frequency substitute | **1 hour** | — |
| B | Rounds screen (create/edit a round in-app) | **half a day** | — |
| C | Meta daily pull, endpoint + scheduling | **1 day** after B | needs B |
| D | Strip test accounts, re-verify | **30 min** | client |
| E | `0826-02`/`0826-03` Registration Lists → re-import → close the +34 | **1 hour** | client |
| F | Malaysia price test read-out | **30 min** | a round has to run |

**A + B + C is the critical path: about two days**, and C cannot start before B because a daily pull
needs somewhere to put a round it has never seen.

D and E are quick but sit behind the client. F needs a round to actually run.

**If nothing new arrives, the app is finished for reporting today.** Everything above is either a
new capability or waiting on somebody else.

---

## 10. Files worth knowing

| Path | What |
|---|---|
| `lib/import/pipeline.ts` | The whole import. Matching, attribution, dedupe, the diff |
| `lib/import/sources.ts` | Column spellings each file accepts (incl. the sequence column) |
| `lib/funnel/data.ts` | Every read. Filter options, cuts, the `elsewhere` probe |
| `lib/funnel/cuts.ts` | Which comparison a tab shows, and `monthOf`. Pure — testable |
| `lib/funnel/chart.ts` | Series, axes, `AMOUNT_OF` (efficiency → its denominator) |
| `components/SpineChart.tsx` | The SVG chart |
| `components/Shell.tsx` | Nav, filters, links |
| `supabase/migrations/ALL.sql` | Append-only. The whole schema |
| `scripts/test-import.mts` | 515 tests. `npm run test:import` |
| `ground-truth-testing/` | Real exports, rebuilt CSVs, reconciliation. **Not for a public remote** |

Migrations are named for what they assert — `0064_a_round_is_in_a_country_if_it_ran_there.sql`.
Each one's header comment says what was wrong and what the numbers were. **Read those before
changing a view**; they are the record of why things are the way they are.
