# Funnel OS Schema Plan

> **Mirrored into the repo on 9 September 2026.** The design lived only as a
> published artifact, so a build plan that pointed at it stopped the moment
> somebody checked the repo out and could not find it. This copy is what the
> build is written against.
>
> **Source:** https://claude.ai/code/artifact/f6d06f53-4f3c-45aa-920f-b18666fb341c
>
> The artifact is the original and may be revised there. If the two ever
> disagree, say which you are following rather than guessing which is current.
>
> **Stale in this copy, deliberately not edited:** the masthead says migrations
> 0001–0069. Production is at **0074** and steps 1–2 of the build order are
> already done. `docs/BUILD-PLAN.md` is the current state; this is the design.


## Four rules that settle the rest

**Store the raw input, derive the label at read.**
Landing page and market already work this way. Source, product and channel do not. After this they all do, so changing a rule restates every past round instantly with nothing to re-import.

**Rules match only on what a lead already carries.**
Four fields: the campaign name, the ad set from utm_term, the ad from utm_content, and the export's own lead-source column. All four are stored today, so no new capture, no re-import, and no dependency on utm_source. The campaign name resolves market, landing page, product and channel; the source column is what makes affiliate work without a tracking parameter. Do not build campaign-only matching — see point 03.

**AcqOS is the only writer of the journey.**
Stage list, order, names and metrics arrive by push. GroundTruth never edits them, so there is no conflict rule to design.

**Absent is not zero, and unknown is visible.**
Existing rule, extended. Anything a rule cannot resolve gets its own labelled column rather than being folded into a default or hidden.

**Build the smallest thing that answers the question.**
A table earns its place by holding something that cannot be derived, or by stopping two copies of a fact from disagreeing. Anything else is a column, a jsonb field, or a calculation at read time. Applied backwards over this plan it removed three of the four tables it originally proposed.

## The whole schema
Fifteen tables when this is done, one fewer than today. Sixteen exist, two are folded away, one is added. The last column says which of the nine points each table serves.

| Table | Status | Holds | Serves |
|---|---|---|---|

**Who and what — identity and structure**

| contacts | exists | One row per person. Email, phone, client. Nothing about campaigns lives here, deliberately. | — |
|---|---|---|---|
| rounds | changed | One row per campaign cycle. Gains a market-scoped id so MY and SG can both run 0526-01. Keeps country as the hand-set fallback. | 06 |
| round_sessions | kept, on sufferance | One row per class inside a round, and today it is strictly one to one — every row was written by a single backfill and nothing has ever added a second. Five views read it, so removing it costs more than the twelve rows it saves. Keep, but build nothing new on it. | — |
| products | folded | Becomes rows in dimension_values, which already carries the key, label, note and order that this table exists for. rounds.product_id stays and points there instead. | 03 |
| client_flags | exists | Funnel OS's own note on an account, chiefly the demo flag. Kept out of the journey table because an AcqOS push wipes that. | — |

**What happened — the facts**

| ads_performance | changed | Spend and delivery per day, campaign, ad set and ad. Would gain measures jsonb, but only when a client needs a figure the four fixed columns do not carry. Unchanged for now. | 04 |
|---|---|---|---|
| events | changed | Every person-level fact: leads, attendance, sales, declared stages. Gains answers jsonb. Loses is_lead, country and close_round_id. | 0102070809 |
| scroll_runs | changed | One Clarity export, curve included. Gains page_key, heatmap_path and points jsonb. | 05 |
| scroll_depths | folded | Nothing reads it. Every read goes through a view that folds its twenty rows straight back into a jsonb array, so it exists only to be un-normalised on the way out. | 05 |

**What things mean — the definitions layer**

| client_journey_config | exists | The stage list and order. AcqOS is the only writer. | 0204 |
|---|---|---|---|
| event_types | exists | The kinds of thing a person can do. A fourth becomes legal by inserting a row, not by altering a table. | 04 |
| journey_metrics | changed | The list of things the app knows how to count. Would gain client_id and aliases under point 04, which is deferred. Unchanged for now. | 04 |
| journey_ratios | not built | Stage N ÷ stage N−1 and spend ÷ stage are already generic. The only exceptions are ROAS and AOV, which is two rows, and both already work where they are. Build it when a third exception turns up. | 04 |
| dimension_values | new — the only one | One row per Paid Ads, Affiliate, MY, SG, LP1, Lead Form, product, channel. Target says which dimension. Carries its own match rules as a jsonb array, its flags, and its order. | 030506 |
| dimension_rules | not built | Rules live on the value they resolve to. Priority is the value's own order then the rule's index, which is clearer than a separate integer — "LP2 is checked before LP1" is exactly a value ordering. | 03 |
| form_questions | not built | The label is the raw form header, which is already the key. The list is a distinct-keys scan of answers, and ordering by lead count beats a hand-set order. Derive it in a view. | 01 |
| client_targets | exists | The number a client agreed for a metric. Read in three places, but nothing writes it, so it is almost certainly empty in production. Wired, unpopulated. | — |

**How it got here — import and audit**

| import_batches | exists | Every file that landed: source, coverage, row count, column map, staleness. The column map is what makes a mapping choice stick. | 0104 |
|---|---|---|---|
| unmatched_rows | exists | Rows that could not be tied to a person with certainty. Two-way: accept, assign or dismiss. | — |
| period_insights | changed | A frozen reading of a round or month. Must now also record the attribution model and rule version that produced it. | 0203 |

### Not tables
- fo_resolve(), new. Takes a target and a campaign name, returns a dimension key. Replaces fo_country() and fo_landing_page().
- v_contact_entry, new view. One row per contact giving their entry touch, so attendance and sales can be grouped by audience without storing it twice.
- v_events, rewritten. Exposes attr_round_id, attr_source, attr_weight and a computed closing round. Every metric view groups on those.
- v_form_questions, new view. The splittable question list, scanned out of answers rather than maintained by hand.
- funnel.attribution, new transaction-local setting, sitting beside the filters that already work this way.
- A Supabase Storage bucket for the heatmap PNGs.

> **Shape** of the change One new table, and it holds definitions rather than facts. Two existing tables fold into it or into jsonb. Everything else added is a column: a place to put what an export already carried and the app was throwing away. The schema ends smaller than it started.

## The efficiency pass
Every table in the plan, existing or proposed, tested against one question: does it hold something that cannot be derived, or stop two copies of a fact from disagreeing?

| Candidate | Verdict | Reasoning |
|---|---|---|
| scroll_depths | cut | Nothing reads it. The only reader is a view that immediately folds its rows back into a jsonb array, so the normalisation is undone on every single read. Curve becomes points jsonb on the run. One table and one join gone, and the integrity argument survives because sessions is still stated once. |
| events.close_round_id | cut | Stored at import, which means it is wrong whenever attendance arrives after sales. The model selector has to walk the chain anyway, so the calculation exists either way. Roughly a hundred sale rows to walk. Computing it also deletes the plan's "extend it to middle sales" item, which becomes no schema change at all. |
| dimension_rules | cut | Folded into the value it resolves to, as a jsonb array. Priority becomes value order then rule index, which is how the existing landing-page function already had to be hand-ordered. |
| products | cut | Holds a key, a label, a note and an order for one to three rows per client. That is exactly the shape of dimension_values. Folding it in also gives channel a registry, which it has never had. |
| journey_ratios | deferred | Two exceptions do not need a table. Build it on the day a client needs a third. |
| form_questions | cut | Every column it holds is derivable from the answers themselves. A view over distinct keys does the same job and cannot fall out of step with the data. |
| round_sessions | kept | You are right that it is one to one. But five views read it and rounds.session_date still exists beside it, so this is a five-view migration to delete twelve rows. Keeping it is the cheaper answer, and it is already there if a client ever runs two classes in a round. |
| dimension_values | built | The one survivor. It holds something genuinely underivable: which campaign-name fragments mean Affiliate, or Malaysia, or Landing Page 2. Nothing in the data says so, which is why that knowledge is hard-coded in two functions today. |

### The same lens on the workflow
- Do not make anyone type the rules. On setup, scan the client's existing campaign names and propose the split: "Found DF_SG_ and DF_MY_ on 41 campaigns. Create SG and MY?" Accepting a proposal is one click; the hand-written rule is the fallback, not the path.
- One dropzone, not five. The column map already fingerprints a file well enough to tell an ads export from a leads export. Asking which source it is, before looking at it, is a question the app can answer itself.
- Derive at read means no backfill screens. Because rules resolve on the way out, there is no re-derive job, no migration to run, and no version of history to reconcile. The preview before saving a rule is the whole workflow.

> **Where** the lens does not apply Two copies of a fact that can disagree is worth a table every time. That is why import_batches, unmatched_rows and period_insights survive without argument: each one records something that is true at a moment and must not be recomputed later.

## The whole workflow
Five phases, from a client that does not exist yet to a frozen report.

### Onboarding a client
- Declare any missing measurement. One row in event_types if people do it, one in journey_metrics either way. Done by us in SQL, once, and rarely.
- AcqOS pushes the journey. Client, stage list, order, slug, name, metric, compare dimension, unit price. A stage naming a measurement nobody declared is refused by name, and the whole push is rejected rather than half-applied.
- Define the dimensions. Rows in dimension_values for this client's sources, markets, landing pages, products and channels, each carrying its own campaign-name rules. Seed them by letting the app scan existing campaign names and propose the split rather than typing rules by hand.
- Optionally set targets in client_targets.

### A round begins
- Insert the round: market-scoped id, client, product, start and end dates.
- Insert its classes into round_sessions, one row per session.
- Launch campaigns named so the rules can read them — market token, page token, round code. The campaign name is the only thing every rule matches on, so it is the one convention that has to hold.

### Import
Every source runs the same shape: drop the file, map the columns, see the diff, commit. Nothing is written until the commit.

| File | Lands in | Notes |
|---|---|---|
| Ads | ads_performance | Deduped on date, campaign, ad set and ad. Unmatched columns offer this client's declared measurements; the pick goes into measures. |
| Leads | contacts + events | Round from the declared list first, then the UTM, then a date window. Unmapped columns can be captured as form questions into answers. |
| Attendance and declared stages | events | Never creates a contact. An unidentified attendee is counted through an anon key instead. |
| Sales | events | Carries the acquiring round and the closing round. A sale with no lead is still a sale. |
| Clarity scroll | scroll_runs | CSV and PNG together, filed by page key, round and device. The curve goes in as jsonb on the same row. |
Anything that cannot be tied to a person with certainty parks in unmatched_rows for accept, assign or dismiss. The importer never invents a person.

### Reading
- Pick filters. Product, channel, market, source, audience and period. All multi-select sets; selecting none means everything.
- Pick the attribution model. One global selector, five options, entry by default.
- One function reads. fo_cut sets every filter and the model as transaction-local settings, then reads one view and returns rows as jsonb.
- Dimensions resolve at read. Views call fo_resolve on the campaign name, so changing a rule changes every past round with nothing re-imported.
- Incoherent spend blanks. If the selection makes a spend figure meaningless, it blanks rather than reading zero.
- Drill. Month to round to asset. A tab drill-down stays on its tab; a filter-bar selection follows you everywhere.

### Freezing
- A round or month insight is frozen into period_insights with its payload.
- It now also records the attribution model and the rule version in force.
- Later rule or model changes do not touch it. Fixing a view does not fix a report, which is what freezing is for.

## Form answers & the split tab
Every qualitative column the lead form captures is stored, and a new tab lets you choose what the columns are.

### Decided
- Store first, classify never
- Split by any answer type
- Multi-select → one column per combination
- Not asked → blank
- New tab, existing tabs untouched

### Schema

| Object | Status | Detail |
|---|---|---|
| events.answers | new column | jsonb, written on lead rows only. Key is the question, value is the cell exactly as GoHighLevel sent it. |
| v_form_questions | new view | Distinct keys scanned out of answers, ordered by how many leads answered. No table: the header is already the label, and a derived list cannot fall out of step with the data. |
| import_batches.column_map | exists | Already remembers the mapping per source. Now also remembers which columns were captured as questions. |

### Import workflow
- Upload the leads export as normal.
- Unmapped columns are listed today and ignored. Each now gets a dropdown: ignore, map to a known field, or capture as form question.
- Capture writes a form_questions row and stores every value into answers.
- The choice is saved to the batch's column map and is the default next time.

### The split tab
- One control picks what the columns are. The list is every existing dimension, landing page, audience, creative, source, market, variant, product, channel, round, plus every captured question.
- Rows are the client's journey spine, identical to every other tab.
- Each distinct stored value becomes one column. A multi-select cell reading Content, Sales, Authority is its own column, exactly as an open-ended answer would be. Columns therefore never overlap and always sum to the total.
- Cap the columns. An open-ended question can carry four hundred distinct answers, and four hundred columns is not a table. Show the top N by lead count, default twenty, and collect the tail into a single Other column that says how many distinct answers it holds. Without this the tab is unusable the first time someone splits by a text question.

> **Watch** Spend lives on ad rows. Split by a form answer and spend, CPL, CPA and both ROAS rows blank out, the same way the source filter already blanks them. Split by audience or landing page and they survive, because ad rows carry those.

## Five attribution models
One global selector decides which touch gets the credit. Every tab follows it.

### Decided
- Default Entry
- Global selector, not per tab
- All five show ROAS; organic reads ∞
- Even split divides sales only
- Previous Paid Ads retired
- Sheet divergence accepted

### The models

| Model | Credit goes to | Answers |
|---|---|---|
| Entry | First touch ever, paid or not | What did this round's spend produce |
| Entry paid | Earliest touch naming a paid campaign | Same, ignoring organic re-entries |
| Last touch | Walk back one stage at a time, first campaign found | Which class closed it |
| Last paid | Same walk, skipping unpaid touches | Which ad was last in the room |
| Even split | Divided across every round they appeared in | Which rounds did the work |

### What even split actually divides

| Measure | Under even split |
|---|---|
| Revenue, preview and middle | Divided. A cell can read 4,158.33. |
| Purchase counts | Divided. A cell can read 87.5. |
| Leads | Whole. A lead happens in exactly one round by definition and is never attributed anywhere else. |
| Attendance | Whole. Same reason — somebody either sat in that class or did not. |
| Spend, impressions, reach, clicks | Untouched. No model moves money that was already spent in a named round. |

### How the walk resolves
Attendance and sales carry no campaign, so credit is found by stepping back one stage at a time until a touch names one.

```
purchase
  ↓ latest initiate checkout before it
     ↓ latest add to cart before that
        ↓ latest click before that   ← campaign, ad set, round

middle sale
  ↓ latest preview sale before it
     ↓ latest attendance before that
        ↓ the lead behind it          ← campaign, ad set, round
```

### Schema

| Object | Status | Detail |
|---|---|---|
| funnel.attribution | new setting | Transaction-local, set the same way the product, channel, country and source filters already are. |
| v_events | rewritten | Exposes attr_round_id, attr_source and attr_weight. Every metric view groups on those instead of on lead_round_id. |
| events.close_round_id | dropped | Computed in the view instead. Stored at import it goes stale whenever attendance lands after sales, and the model has to walk the chain regardless. |
| v_source_buckets | retired | Previous Paid Ads was entry attribution apologising for itself. The selector says it properly. |
| period_insights | stamped | Records which model and which rule version produced it, so a frozen report still explains its own numbers. |
| keepsSpend | rewritten | Reads the source's has_ad_spend flag instead of matching two literal strings. |

> **Watch** Attribution moves credit between columns but never changes a grand total, so the journey strip only moves once a filter is applied. Even split is the one model where a sale does not land in exactly one column; it lands fractionally in several and still sums to the same total.

## The rules engine
One mechanism defines source, market, landing page, product and channel. It replaces two hard-coded functions and a branch in the importer.

### Decided
- Five targets
- Everything matches on campaign name
- Derived at read, so a rule change restates history
- Unresolved source → Organic
- Unresolved market → visible Unknown column

### Schema

| Object | Status | Detail |
|---|---|---|
| dimension_values | new table | client_id, target, key, label, ord, note, flags, rules. One row per Paid Ads, Affiliate, MY, SG, LP1, Lead Form, product, channel. Rules ride on the value as a jsonb array, so there is no second table and priority is just the value's own order. |
| products | folded in | Same shape, one to three rows per client. Becomes target product, and channel gets the registry it never had. |
| fo_resolve() | new function | Takes a target and a campaign name, returns a key. Called by v_ads and v_events. |
| fo_country() | retired | The DF_XX_ prefix becomes two rows and two rules. |
| fo_landing_page() | retired | Its seven-branch CASE becomes seven rules, in the same order. |

### Operators
Ten, case-insensitive by default. Regex is the escape hatch, not the habit.
- contains
- does not contain
- is
- is not
- starts with
- ends with
- is empty
- is not empty
- is one of
- matches regex

### Fields a rule can match on
Four, and every one is already stored on the lead row today. No new capture is needed for any of the five dimensions.

| Field | Where it comes from | Typically resolves |
|---|---|---|
| utm_campaign | The tracking link, verbatim | Market, landing page, product, channel |
| ad_set | utm_term | Audience |
| ad | utm_content | Creative |
| source column | The export's own lead-source field, which the importer already reads and already lets win over its fallback | Source, including affiliate and community |

### User workflow
- Settings → Dimensions → pick a target. The app scans existing campaign names and proposes what it found, so most values arrive by accepting a suggestion.
- Add or edit a rule on the value: utm_campaign contains "AFF" → Affiliate. Values are checked in their own display order, so LP2 before LP1 is just LP2 sitting higher in the list.
- Preview shows what moves: 380 leads Organic → Affiliate, 32 Paid Ads → Affiliate.
- Save. Every past round re-reads immediately. Nothing is re-imported and no stored value changes.

> **Affiliate,** resolved Not blocked, and not dependent on utm_source. Three paths, and the first two cost nothing. Issue affiliate links through a redirect you control, so the campaign token is appended server-side and the affiliate never handles the raw link. Or match on the export's own lead-source field, which is already captured and already outranks the importer's fallback. A dedicated landing page per affiliate is the third, and identifies them with no tracking parameter at all. Use the first two together and the second covers you when a link gets stripped.

## Journey & ads measures
The people side is already dynamic. The ads side is four fixed columns, and that is the row group on your screenshot.

### Decided
- AcqOS is sole writer of the journey
- Extra measures in jsonb, not a long table
- Custom conversions stay delivery figures
- Reach keeps being summed for now
- Deferred — no live client needs it

> **Not** now Shely needs none of this: six core metrics, no video views, no custom conversions. It becomes necessary the day a client's journey names an ads figure the app does not have, and waiting costs nothing — the columns can be added at any point and the read-boundary merge already exists. Read this section as the answer to that day, not as work to schedule.

### Three things, two owners
The journey and the vocabulary are different, and they already have different owners in the code today. No new syncing mechanism is proposed; the one-way push already exists.

| Thing | Owner | Lives in |
|---|---|---|
| Which stages, their order and names, which measurement each uses | AcqOS, by push | client_journey_config |
| What measurements exist, and where each number comes from | GroundTruth, by migration | event_types, journey_metrics |
| Which column in this file is that measurement | Whoever uploads the file | import_batches.column_map |
AcqOS cannot own the middle row. A measurement says video views comes from the ads export, which is a fact about this app's plumbing rather than the client's funnel, and AcqOS does not know what Meta exports or what the importer can read. It cannot own the bottom row either, because it never sees the file. That is why the push validator already refuses a stage naming a measurement nobody declared, and names both the stage and the word rather than failing vaguely.
Auto-creating the measurement instead would be worse. A typo in AcqOS would silently produce a stage that counts nothing and renders blank forever, with no error anywhere. Refusing loudly is the deliberate choice.

### How a stage finds its events today
Not by name. The stage name is display text and can be anything.

### Schema

| Object | Status | Detail |
|---|---|---|
| event_types | exists | Migration 0048. The kinds of thing a person can do. |
| journey_metrics | exists | Migration 0048. The list of things the app knows how to count. Would gain client_id and aliases on the day above, not before. |
| client_journey_config | exists | Migration 0001. Stage list and order, replaced wholesale by an AcqOS push. |
| journey_metrics.client_id | when needed | Nullable. Null means global and core; a value means this client only. |
| journey_metrics.aliases | when needed | Header spellings the importer should recognise, e.g. ThruPlays. |
| ads_performance.measures | when needed | jsonb. Spend, impressions, reach and clicks stay real columns because every ratio depends on them. |
| journey_ratios | deferred | ROAS and AOV are the only exceptions and both already work. Two rows do not need a table; build it on the day a third turns up. |

### Adding video views, end to end
- Insert one row into journey_metrics: metric video_views, source ads, aliases ThruPlays and Video plays.
- Upload the Meta export. The importer sees a ThruPlays column, matches the alias, writes into measures.
- AcqOS pushes a stage naming video_views.
- The row appears in the spine. Its rate against the previous stage and its cost-per come free, because both are already generic.

### Column mapping
- Today each field carries a hard-coded alias list. Headers are lowercased, stripped of punctuation and looked up. A required field with no match refuses the import and names it. An extra column is listed and ignored, never guessed.
- The change: an unmatched column gets a dropdown of this client's declared measurements plus ignore. You pick a measurement for a column, not an event name.

> **Watch** A Meta custom conversion is Meta's own count, not a person, so it can never join to a contact. Keep it in the ads spine. Counting it as a funnel stage would double-count against the CRM's own leads.

## Clarity & landing pages
The scroll curve and the campaign are joined by a page key that both sides resolve to.

### Decided
- Pages are rows, via the rules engine
- Store the PNG
- Depth ranges now, sections later
- An edited page is a new page

### Schema

| Object | Status | Detail |
|---|---|---|
| scroll_runs | absorbs the curve | Migration 0032. One export: sessions, device, window, URL pattern, project name. Gains points jsonb. |
| scroll_depths | folded | Nothing reads it. The only reader is a view that folds its twenty rows back into jsonb, so the normalisation is undone on every read. |
| scroll_runs.page_key | new column | The join. Campaign rules resolve one side, URL rules the other. |
| scroll_runs.heatmap_path | new column | Points at a Supabase Storage object. No image is stored anywhere today. |
| storage bucket | new | Holds the PNG. A display asset the app cannot compute on, but the drill-down needs it. |

### Analysis flow
- Month reads low. Drill to the round.
- This round flags Lead Gen % below baseline. That flag already exists.
- Split the round by landing page. If one page carries the drop, continue. If not, stop, it is not a page problem.
- Pull that page's curve for that window against a good baseline round, same page key and same device.
- Report the first depth band where the gap exceeds threshold, as a range. The existing form-position bound stays the sanity check.

> **Watch** Clarity's export API only reaches back three days, so this stays a manual export per round, page and device. A filename convention carrying the page key and device lets the importer file it without asking.

## Markets & round naming
Market becomes a first-class dimension, and MY and SG stop fighting over round codes.

### Decided
- Market is first class
- Round-level market stays as a manual fallback
- Unresolved → Unknown market, visible
- Dual-market round → latest sign-up wins
- Per-market round names
- Ads resolver reads market before date

### How an event gets its market

| Event | Market comes from |
|---|---|
| Ad row | Its own campaign name, through the rules |
| Lead | Its own utm_campaign, through the same rules |
| Attendance | The round it belongs to |
| Attendance in a dual-market round | The person's latest lead in that round |
| Sale | Whatever the selected model credits |
The same person appears in both the MY and SG tables, as different rows. Nothing stamps one country on a person any more.

### Schema

| Object | Status | Detail |
|---|---|---|
| dimension_values | from 03 | MY and SG become rows with target market. |
| rounds.country | kept | The hand-set answer for a round whose campaign names say nothing. Costs nothing, covers the messy case. |
| events.country | redundant | Derive-at-read makes it unnecessary and removes the re-import it would have needed. |
| rounds.round_id | scoped | Prefixed by market, the way Northsea already uses NS-. Unique on client, product, market, channel and code. |

### The ads importer is the real hole
Round scoping is often described as a lead-list problem, where a registration list says 0526-01 and the resolver has to know which one. That is the easy half, because the import batch knows its market. The dangerous half is the ads importer, and it fails silently.
One line decides an ads row's round today. It takes the first round whose window contains the spend date, and only falls back to reading the round out of the campaign name when no round matches at all:

```
const round = rounds.find(x => x.start_date <= date && date <= x.end_date) ?? roundFromCampaign(campaign, rounds);
```
The moment MY and SG run overlapping windows, both rounds match that date and array order picks the winner. Malaysian spend lands on a Singapore round, no warning is raised, and every downstream figure inherits the error. There is one ads ingestion path, so this line is the single point of failure, and the Meta pull runs through the same planner.

### The fix
- Invert the precedence. The campaign name is the authoritative signal because it carries the market. The date becomes the tiebreaker within that market, not the primary key.
- Resolve the market first from the campaign name, through the same rules every other dimension uses.
- Filter the candidate rounds to that market, then match the date inside that set.
- Fall back to today's behaviour only when the campaign names no market, and warn when more than one round still matches, rather than silently taking the first.
- Teach roundFromCampaign to resolve market plus code, not code alone. A campaign reading DF_MY_..._0526_01 must resolve to the Malaysian 0526-01, never the Singaporean one.

> **Watch** Round scoping is the heaviest change in this document. round_id is a global primary key referenced from nine tables. Build it last, but fix the ads resolver as part of it and not after — the day two markets overlap is the day the old rule starts producing wrong spend, and nothing on screen will say so.

## Audience as a filter
Two levels, deliberately different. A filter-bar selection flows everywhere; a drill-down inside a tab stays there.

### Decided
- Filter bar → flows across tabs
- Tab drill-down → stays local
- No backfill onto attendance or sales
- No audience registry, names do not drift
Audience is on ad rows and on lead rows today. It is empty on attendance and sale rows, which is why the app never carried a drill-down across tabs: it would have shown a number it could not work out. The model makes it computable, so audience becomes a proper filter beside Country and Source.

### Where each row gets its audience

| Row | By page | By audience |
|---|---|---|
| Spend, impressions, clicks | Ad row campaign, through the rules | Ad row ad_set, directly |
| Leads | Lead utm_campaign, through the rules | Lead ad_set, directly |
| Attendance, sales | Model resolves to a lead, take its page | Model resolves to a lead, take its ad set |

### Schema

| Object | Status | Detail |
|---|---|---|
| v_contact_entry | new view | One row per contact: entry round, ad set, ad, source, page, market, variant. Never stored, always follows the model. |
| events.ad_set / .ad | unchanged | Stay on lead rows only. Copying them onto attendance and sales would freeze one model into the data. |

> **Watch** The same table means five different things depending on the model, so the tab has to say which is active. The property to test: under every model except even split, each sale lands in exactly one audience column and the columns still sum to the total.

## Cross-round exposure
Already recorded. No schema change, no screen, until cohort analysis.

### Decided
- Data already exists
- No user-facing view for now
- Revisit with cohort analysis
A contact who registers for two rounds already has two lead rows, each carrying its own ad set, creative and campaign. The dedupe key is type, contact, round and day, so a second round writes a second row while a same-day repeat is dropped. That is exactly why those columns sit on the event and not on the contact: storing them on the person would collapse May's ad and June's ad into one.
The importer already relies on it. Its earliest-lead lookup exists because somebody registered in May and again in June, and entry attribution has to pick the first.

> **Watch** Meta gives no per-person impressions. Seeing an ad across rounds is only observable when the click turned into a registration, so any future cohort view understates exposure and must say so.

## Dropping is_lead
Written once, read nowhere.
The column was meant to mark a sale with no lead behind it, counted in revenue and excluded from ROAS. The exclusion actually runs off the attribution bucket, and the fact itself is already stated by lead_round_id is null. Nothing reads the column.
A view column cannot be removed in place, so it goes with the v_events rewrite in point 02 rather than in a migration of its own.

## Build order
Ordered by what unblocks what, not by value.
- Rules engineOne table and one function. Points 03, 05 and 06 all sit on it, and it absorbs products. Retires two hard-coded functions on the way.
- Attribution models, three columns dropped, v_contact_entryOne v_events rewrite carries all of it: the model, is_lead, country and close_round_id all go in the same migration. Stamp period_insights before this ships.
- Audience filterSmall once v_contact_entry exists. Delivers the personalisation work you actually want next.
- Form answers and the split tabIndependent of everything above. Could move earlier if the propositions work needs it.
- Clarity page key and PNG storageNeeds the page rules from step one.
- Round naming, and the ads resolver with itLast. Nine tables reference round_id. The ads importer's date-first round lookup must be inverted to market-first in the same piece of work, or overlapping markets start producing silently wrong spend.
Outside the list: ads measures (point 04). Not scheduled, because no client needs it. It starts the day a journey names an ads figure the app does not have, and nothing above waits on it.

## What moves reported numbers
Four changes alter figures already shown to the client. All are intended.

| Change | Effect |
|---|---|
| Previous Paid Ads retired | The By source split loses a column. Its revenue moves into Paid Ads under entry, or into the closing round under last touch. |
| Organic ROAS | Blank today, reads ∞ after. A display change, not an arithmetic one. |
| Unknown buckets made visible | Unresolved markets and pages stop hiding. Column counts go up, totals do not. |
| Any model other than entry | Every per-round figure below the lead line moves. Totals never do. |
Frozen period insights must carry the model and the rule version before any of this ships, or an old report stops being able to explain itself.

