# Funnel OS — build plan for the nine requirements

**For:** whoever builds the rest of this, human or model.
**State:** 9 September 2026. Migrations **0001–0074 applied to production**. Step 1 of 6 is done
and verified. Nothing else is started.

The design is settled in the **Funnel OS Schema Plan**. That document says *what* and *why*. This
one says *where we are*, *what to do next*, and *how to prove you have not broken anything*. Read
the schema plan first; do not re-litigate its decisions here.

---

## 0. The one number

```
spend 20,474.78 · leads 1,889 · attendance 682 · purchases 113 (88 preview + 25 middle)
revenue 83,927.00 · ROAS 1.80 · CPA 365.62
```

**Every migration in steps 1–5 must leave these untouched.** They are reconciled against the
client's own spreadsheet and he checks them. Step 6 (round naming) and the attribution selector are
the only work permitted to move a figure, and both are listed in the schema plan's *What moves
reported numbers*.

Read them with:

```bash
curl -s "$SUPABASE_URL/rest/v1/rpc/fo_cut" -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_view":"v_metrics_total","p_client":"shely"}'
```

---

## 1. Rules that are not negotiable

**Never run `supabase db push`.** The migration ledger is empty, so it replays `0001_schema.sql`,
which drops every table. There is no undo.

**You do not run production SQL. The client does.** Write the file, put it in
`ground-truth-testing/_build/` with the next number, and he pastes it into the Supabase SQL editor.
Every migration ends with a *check after running* block: the exact queries and the exact expected
values.

**Verify through the app's key, never the SQL editor.** This has already cost one round trip. The
editor connects as a superuser and sees rows the app cannot. `0073` passed every check in the editor
and returned **44 mismatches out of 46** when asked through the anon key, because the new table had
row-level security on and no policy. A comparison that is not asked the way the app asks proves
nothing.

**A migration that changes what the app READS must be provably inert first.** `0073` created the
table, the function and the seed and wired nothing. That is why the RLS fault cost a follow-up
migration instead of a broken screen. Had the views been switched in the same file, every campaign
would have resolved to null — no market, no landing page, empty country filter — **and the totals
would still have read 20,474.78**, because a total does not care how its rows are labelled.

**A new table needs four lines, not one.** Grant is necessary and not sufficient:

```sql
alter table X enable row level security;
drop policy if exists "demo read" on X;
create policy "demo read" on X for select using (true);
grant select on X to anon, authenticated;
```

**Migration first, then code.** Pushing `main` deploys. There is no staging.

**`shely` is real client data.** Never put fixture rows on it. `northsea_supply` and `DEMO-W1`–`W4`
are AcqOS fixtures — do not change them, but **do** seed them whenever a new definition table
appears, or rewiring a view will blank the demo.

**Blank is never zero.** Absent means nobody measured. Zero means somebody counted none.

---

## 2. Where the build is

| Step | Work | State |
|---|---|---|
| **1** | **Rules engine** | ✅ **done and verified** — `0073`, `0074` |
| 2 | Rewire the views onto it | ⬜ next, `0075` |
| 3 | Attribution models + drop three columns | ⬜ |
| 4 | Audience filter | ⬜ |
| 5 | Form answers and the split tab | ⬜ |
| 6 | Clarity page key and heatmap storage | ⬜ |
| 7 | Round naming, **with the ads resolver** | ⬜ last |

Mapping to the nine requirements: **3** is steps 1–2. **2** and **9** are step 3. **7** is step 4.
**1** is step 5. **5** is step 6. **6** is step 7. **4** is deferred — no client needs it. **8** is
already stored and needs nothing.

### What exists now

`dimension_values` — one row per market and landing-page value, each carrying its own match rules as
a jsonb array. Priority is the row's own `ord`, so *LP2 before LP1* is a position in a list.

`fo_resolve(client, target, campaign, ad_set, ad, source)` — first value whose rules match, in order.
`flags.none` resolves to NULL; `flags.catch_all` matches what is left.

`fo_rule_ok(rule, campaign, ad_set, ad, source)` — ten operators, case-insensitive, regex as the
escape hatch. An unimplemented operator returns false, never true.

`lib/funnel/rules.ts` — the same matcher in TypeScript so a rule can be checked without a database,
and so the preview screen can show what moves without a round trip. **The two must agree case for
case.** Same arrangement `lib/funnel/filters.ts` already has with `fo_source_keeps_spend`.

Seeded: `shely` market SG/MY, landing page LP1/LP2/Lead Form plus a `(not a page)` exclusion row.
`northsea_supply` landing page only.

**Verified 9 Sept through the anon key: 46 distinct campaign names, 0 mismatches** against both
`fo_country` and `fo_landing_page`. **624 tests.**

Nothing reads any of it yet. Two hard-coded functions still decide market and landing page.

---

## 3. Step 2 — rewire the views (`0075`)

The whole point of step 1, and the riskiest single migration in the plan, because it is the first
one where a mistake changes a number.

### What to change

| Object | From | To |
|---|---|---|
| `v_ads` | `fo_country(campaign)` | `fo_resolve(client_id, 'market', campaign)` |
| `v_events` | `fo_country(utm_campaign)` | `fo_resolve(client_id, 'market', utm_campaign, ad_set, ad, source)` |
| `v_metrics_by_lp`, `v_metrics_by_lp_round` | `fo_landing_page(...)` | `fo_resolve(..., 'landing_page', ...)` |
| `fo_round_country_ok`, `fo_round_country_pick` | `fo_country(...)` | `fo_resolve(...)` |
| `v_client_countries`, `v_metrics_by_month` | `fo_country(...)` | `fo_resolve(...)` |

`fo_country` has **seven** dependents and `fo_landing_page` has four. Find them before you start:

```sql
select p.proname, pg_get_functiondef(p.oid) ~ 'fo_country' as uses_country
from pg_proc p where pg_get_functiondef(p.oid) ~ 'fo_(country|landing_page)\(';
```

**Do not drop either function in this migration.** Leave both in place as dead code, retire them in
a later one once the app has run on the rules for a week. A migration that changes behaviour and
removes the thing it replaced cannot be half-rolled-back.

### The efficiency problem, and the fix

`fo_resolve` is a scalar function evaluating a jsonb rule array. Called per row, per target, it runs
roughly **1,832 ad rows × 5 targets ≈ 9,000 evaluations** on every read of every metric view.

**There are about 25 distinct campaign names, not 1,832.** Resolve once per name and join:

```sql
create or replace view v_campaign_dimensions as
select c.client_id, c.campaign,
       fo_resolve(c.client_id, 'market',       c.campaign) as market,
       fo_resolve(c.client_id, 'landing_page', c.campaign) as landing_page
from (
  select distinct r.client_id, a.campaign from ads_performance a join rounds r using (round_id)
  union
  select distinct r.client_id, e.utm_campaign from events e join rounds r using (round_id)
) c;
```

Same derive-at-read semantics — change a rule and everything restates — with the work done ~25 times
instead of ~9,000. Views join this instead of calling the function inline.

**Caveat:** this only holds for targets whose rules read the campaign alone. A source rule matching
the `source` column cannot be cached by campaign. Keep `fo_resolve` inline for `source`, or widen the
cache key to `(campaign, source)`, whichever the rules in play require. **Do not silently cache a
target whose rules read a second field.**

### Prove it

1. **Before**, capture the totals from §0 and the per-round table.
2. Run the migration.
3. **After**, capture both again. `diff` them. **Any change is a failure.**
4. Then, through the anon key:

```
country=SG     12 rounds, spend 19,485.25
country=MY      1 round,  spend    989.53
country=SG,MY  12 rounds, spend 20,474.78
LP1  spend 11,853.47 · leads 738 · show 26.8% · ROAS 1.88
LP2  spend  3,056.16 · leads 216 · show 20.4% · ROAS 0.66
Lead Form  leads 595 · spend 5,565.15
```

5. And the demo client still renders. It has landing-page rows but **no market rows**, so its market
   must read null everywhere and its round list must be unchanged.

### Then requirement 3 is done

Adding Affiliate becomes one row:

```sql
insert into dimension_values (client_id, target, key, label, ord, rules) values
('shely','source','Affiliate','Affiliate',15,
 '[{"field":"campaign","op":"contains","value":"AFF"},
   {"field":"source","op":"contains","value":"affiliate"}]'::jsonb);
```

The second rule is the one that matters: **`utm_source` is not captured and never has been**, so an
affiliate link with no campaign token is invisible unless the export's own lead-source column names
it. Both rules together cover a stripped link.

---

## 4. Step 3 — attribution (`0076`), the biggest one

Requirements **2** and **9**. Read schema plan §02 in full first.

**Stamp `period_insights` before anything else in this step.** A frozen report that cannot say which
model produced it stops being able to explain its own numbers, and every report already sent to the
client becomes unexplainable. This is not optional and it is not a later cleanup.

Then, in one `v_events` rewrite:

- expose `attr_round_id`, `attr_source`, `attr_weight`
- drop `is_lead`, `country`, `close_round_id` — **and remove `pipeline.ts:1171`, which still writes
  `is_lead`, in the same change or the next import fails**
- retire `v_source_buckets`; `Previous Paid Ads` goes with it
- add `funnel.attribution` as a transaction-local setting beside the existing filters

### The five models

`entry` (default) · `entry_paid` · `last_touch` · `last_paid` · `even_split`

### What even split divides

| | |
|---|---|
| Revenue, purchase counts | **divided** — a cell can read 87.5 |
| Leads, attendance | **whole** — a lead happens in exactly one round by definition |
| Spend, impressions, reach, clicks | **untouched** — no model moves money already spent |

**This is the part the schema plan understates.** "Group on `attr_weight`" is not a regroup: every
`count(*) filter (...)` on a divided measure becomes `sum(attr_weight) filter (...)`. Leads and
attendance keep `count(*)`. Get this wrong and totals stop summing.

**Test property:** under every model except `even_split`, each sale lands in exactly one column and
the columns sum to the total. Under `even_split` they sum to the same total fractionally. **The grand
total never moves under any model** — only its distribution across columns.

---

## 5. Steps 4–7, in order

**Step 4 — audience filter (requirement 7).** Small once `v_contact_entry` exists. That view is one
row per contact giving their entry touch, never stored, always following the selected model.
Audience is on ad rows and lead rows today and empty on attendance and sales; the model is what makes
it computable. Filter-bar selection flows across tabs; a tab drill-down stays local. **That reverses
the existing "an asset does not follow you to another tab" rule — deliberate, so say so on screen.**

**Step 5 — form answers and the split tab (requirement 1).** Independent of everything above; can
move earlier. `events.answers` jsonb on lead rows, `v_form_questions` as a derived view, no table.

The data arrives as extra columns on the same GoHighLevel export already imported — the client ticks
three form fields before exporting. **Cap the columns at the top twenty by lead count with an Other
column saying how many distinct answers it holds**, or one free-text question produces ~1,500
columns and the tab is unusable.

**One thing to say on the tab:** GHL stores those answers on the *contact*, not the registration, so
a repeat registrant's older answer is unrecoverable. The tab must say the answers are the person's
most recent.

`Business Name` is already in every export and currently discarded — it becomes a splittable question
for free.

**Step 6 — Clarity (requirement 5).** Needs the page rules from step 2. `scroll_runs` gains
`page_key`, `heatmap_path` and `points` jsonb; `scroll_depths` folds away. A Supabase Storage bucket
holds the PNG. Clarity's API only reaches back three days, so this stays a manual export per round,
page and device.

**Step 7 — round naming (requirement 6), last, and carrying the ads resolver.**

`round_id` is referenced from six tables and is a global primary key. The heavy part is not the
schema, it is the import resolver.

**The ads importer is the real hole.** One line in `lib/import/pipeline.ts` decides an ads row's
round:

```ts
const round =
  rounds.find(x => x.start_date <= date && date <= x.end_date)
  ?? roundFromCampaign(campaign, rounds);
```

Date first, campaign name only as a fallback. The moment MY and SG run overlapping windows both
rounds match and **array order decides the winner, silently**. Malaysian spend lands on a Singapore
round and every downstream figure inherits it. There is one ads ingestion path, so this line is the
single point of failure — **and the Meta pull runs through the same planner.**

**The fix:** resolve the market from the campaign name first, filter the candidate rounds to that
market, then match the date inside that set. Fall back to today's behaviour only when the campaign
names no market, and **warn when more than one round still matches** rather than taking the first.
Teach `roundFromCampaign` to resolve market plus code, not code alone, or `DF_MY_..._0526_01`
resolves to the Singaporean round.

**Do not defer this past the round-naming work.** The day two markets overlap is the day the old rule
starts producing wrong spend, and nothing on screen will say so.

---

## 6. How to verify anything

```bash
npm run test:import        # 624 tests
npm run test:integration   # 8
npx tsc --noEmit
npm run build
```

`npm run lint` is not configured. Do not add it as a gate.

**Reading production** — always through the anon key, never the editor:

```bash
export $(grep -E '^NEXT_PUBLIC_SUPABASE_(URL|ANON_KEY)=' .env.local | xargs)
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/rpc/fo_cut" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
  -d '{"p_view":"v_metrics_by_round","p_client":"shely"}'
```

`fo_cut` returns opaque jsonb with the metrics under `m`. There are no columns to select. In SQL,
alias the call: `from fo_cut(...) as r` then `r->'m'->>'spend'`.

**PostgREST caps every response at 1,000 rows** and an explicit `limit=10000` still returns 1,000.
`ads_performance` has 1,832. Never fold raw rows client-side to build a complete list — aggregate in
SQL or page with `fetchAll`. This has already produced one silently wrong answer.

**A drill-down must sum to its parent.** After any change touching `v_events` or `v_ads`, check all
four: creatives, targeting, variants, landing pages.

---

## 7. Traps that have already cost time

- **Reach is not additive.** It counts distinct people. `0016`'s rule reads the coarsest row:
  `coalesce(sum(reach) filter (where ad_set is null), sum(reach))`. Six ad sets of `0526-02` sum to
  20,665 against a true 11,380. A round may hold **one** coarse reach row; a second is summed into
  the first.
- **A round can run two countries.** `0926-01` ran SG and MY together. Country lives on the ad row
  and the lead, never on the round alone.
- **People register before the ads run.** On one list, 74 of 97 registrants signed up while the
  previous round was still advertising. Never infer a round from a date when the file names one.
- **Applying the Paid Ads filter** narrows to same-round revenue and understates per-creative ROAS.
  The unfiltered Ads tab is the honest comparison.
- **A month is the rounds named for it, whole.** `0926-01` is September though its ads opened
  28 August. Client ruling, migration `0069`.
- **The Meta pull exists** (`app/api/meta-pull`, `lib/meta/*`) and writes `ads_performance` through
  the same planner as a CSV. Anything that changes round assignment changes the pull.
- **The client reads every number against his own sheet.** If a figure changes, say which, by how
  much, and why, before he finds it.

---

## 8. Convention worth keeping

Every migration in this repo opens with a long header: what was wrong, what the ruling is, who else
reads the object, what the figures should be afterwards, and how to roll it back. That is why a
decision made in May can still be audited in September.

Commit subjects are sentences stating the rule the change establishes — *"A filter is a set, not a
value"* — not `feat:` prefixes. Migration filenames follow the same style.

Keep both.
