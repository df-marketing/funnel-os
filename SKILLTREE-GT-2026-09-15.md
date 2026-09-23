# GT (GroundTruth / "Funnel OS") — skill tree

**Read from the codebase on 15 Sep 2026**, checkout `funnel-os`, and **merged to `main` the same
day** — so everything below is on the production branch. No commit hash is pinned here on purpose:
it would be stale by the next deploy. **`GET /api/health` returns the live `commit`** — that is the
authoritative answer to what production is actually serving. Every leaf points at a route file, a
page, or the loader behind one. Nothing here is from a handover doc or from memory.

⚠️ **One leaf needs a migration that has not been run.** `list-periods` answers `503` naming
`20260915090000_a_period_can_say_whether_it_is_finished.sql` until someone applies it by hand.

**`<OTHER>` = GU (GroundUp / "AcqOS").** I have read GU's *skill tree file*
(`SKILLTREE-GU-2026-09-14.md`), **not GU's repository**. So every overlap below is confirmed or
refuted from **GT's** code against **GU's claim** — the claim itself I have taken on trust.

**I walked pages as well as routes**, because GU's pass flagged that enumerating handlers alone
would under-report `blocked`. It does: GT's `blocked` list has **18 entries**, and 14 of them are
API routes that exist but are unreachable without a browser session.

---

## The organizing questions

| Level | Question |
|---|---|
| **1** | What stage of a figure's life does this act on? |
| **2** | Which object inside that stage does the skill act on? |
| **3** | What can you do to that object? *(leaves)* |

**Level 1 differs from GU's deliberately.** GU asks *"which part of the acquisition loop?"* — and
GT has no part in that loop. It does not plan, own creative, or run anything. Mapping GT onto
`strategy / assets / campaign` would leave three empty branches and cram every leaf into
`reporting`. GT's own spine is a figure's lifecycle, and the code is laid out along it:
`lib/import/` → `dimension_values` → `fo_cut` → `period_insights` → `lib/auth/`.

**Levels 2 and 3 are GU's, unchanged**, so the trees merge below the root.

Three levels. Not deeper — a fourth would only re-split verbs.

---

## 1 · The tree

### Level 1 — *What stage of a figure's life?*

- **Ingest** — getting facts in
- **Meaning** — what a fact is called
- **Read** — getting figures out
- **Record** — keeping a figure that must not change
- **Governance** — who may see it, and is it working

---

#### Ingest
*Level 2 — which object?*

- **An export file**
  - preview-import · commit-import · discard-staged-import · download-template
- **A Meta ad account**
  - dry-run-pull · commit-pull
- **A parked row**
  - accept-best-guess · assign-identity · dismiss
- **A scroll heatmap**
  - attach · detach

#### Meaning
*Level 2 — which object?*

- **A dimension rule**
  - list-rules · propose-rules-from-data · create-rule · delete-rule
- **The funnel schema**
  - push-schema

#### Read
*Level 2 — which object?*

- **A series**
  - read-exposed-cut · read-landing-page-cut · read-class-variant-cut · drill-into-asset
- **A period's narrative**
  - read-round-insight · read-month-insight
- **An account snapshot**
  - read-actuals
- **The period list**
  - list-periods
- **Form answers**
  - read-answer-split

#### Record
*Level 2 — which object?*

- **A frozen period reading**
  - freeze-round · freeze-month · read-frozen-version

#### Governance
*Level 2 — which object?*

- **A client handle**
  - claim-handle
- **A client login**
  - grant-login · revoke-login
- **The refusal contract**
  - read-refusals
- **The deployment**
  - check-health
- **The read cache**
  - refresh-cache · warm-cache

---

## 2 · Flat leaf table

`R` = read · `W` = write · `D` = destructive.

> ⚠️ **Read `anySourceStale` before you read any number.** Every read route returns
> `anySourceStale` and `lastObservationDate` at the **top level** (also still nested under
> `coverage`), plus `daysBehind` and `staleSources`. A stale figure is not a slightly-old figure:
> coverage ends at the **earliest** `coverage_end` across sources, so a ratio can have a numerator
> that stopped before its denominator did. Shely on 15 Sep reads `anySourceStale: true`,
> `lastObservationDate: 2026-09-02`, 12 days behind on all five sources. Quote the caveat with the
> number, or use `list-periods` to find the months that are safe to report.

**Machine reachability: two auth classes exist, and they do not overlap.**
**Integration key** (`x-integration-key`) reaches the ten `/api/integration/*` routes plus
`/api/health` — these are the only paths middleware leaves open
(`lib/supabase/middleware.ts:62-73`). A second key, `INTEGRATION_READONLY_KEY`, reaches the six
GET routes **only** — `actuals`, `series`, `month-insight`, `round-insight`, `periods`, `refusals`
(`lib/integration/auth.ts:57,66`) — that is the one to give an agent.
**Staff session** (a Supabase cookie via `requireStaff()`, `lib/auth/access.ts`) guards everything
else. **There is no key-based door to the operator routes**, which is why `machine` reads `no`
for half this table.

| id | ask | reads / writes | access | machine | inputs | output | caveats | evidence |
|---|---|---|---|---|---|---|---|---|
| gt.ingest.file.preview-import | "Show me what this leads export would change before I commit it" | R `lib/import/pipeline.ts planImport` / W `import_batches` (staged) | W | **no** — staff session | multipart `file`, `clientId`, `source` ∈ ads/leads/attendance/sales/scroll | plan + diff, `batchId` | 15MB cap; staging discards any prior staged batch for that client+source | `app/api/import/preview/route.ts:21,36,45` |
| gt.ingest.file.commit-import | "Apply the import I just previewed" | R `import_batches.staged_payload` / W `contacts`,`events`,`ads_performance`,`unmatched_rows`,`scroll_runs`,`scroll_depths` | W | **no** — staff session | `batchId` | `{ok, invalidated[]}` | Commits **discard every other staged plan** for that client, by design | `app/api/import/commit/route.ts:40,53,71` |
| gt.ingest.file.discard-staged-import | "Throw away that staged file, I'm not committing it" | R / W `import_batches.status='discarded'` | W | **no** — staff session | `batchId` | `{ok}` | none | `app/api/import/commit/route.ts:98` |
| gt.ingest.file.download-template | "Give me the CSV template for attendance" | R `lib/import/sources.ts SOURCES` / none | R | **no** — staff session | `source` path param | CSV | Scroll has no template; Clarity exports it | `app/api/template/[source]/route.ts:15,20` |
| gt.ingest.meta.dry-run-pull | "Pull Shely's Meta spend for last week but don't write it" | R Meta Graph, `rounds` / none | R | yes — integration key | `clientId`,`since`,`until`,`clicks?` | counts + would-write rows | Max 30 days per pull; not a backfill | `app/api/integration/meta-pull/route.ts:68,74` |
| gt.ingest.meta.commit-pull | "Pull Shely's Meta spend for last week and save it" | R Meta Graph / W `import_batches`,`ads_performance` | W | yes — integration key | as above + `commit:true` | counts + batch id | Two doors: staff route rate-limits commits (429), integration route does not | `app/api/meta-pull/route.ts:37,47`; `lib/meta/pull.ts:161,177` |
| gt.ingest.parked.accept-best-guess | "Accept the match this parked row already guessed" | R `unmatched_rows` / W `events`,`contacts`,`unmatched_rows` | W | **no** — staff session | `rowId`, `action:"accept"` | `{ok, outcome}` | Only some rows carry a `best_guess` | `app/api/unmatched/resolve/route.ts:34,52,80` |
| gt.ingest.parked.assign-identity | "This parked row is jane@x.com — assign it" | R `unmatched_rows`,`contacts` / W `events`,`contacts`,`unmatched_rows` | W | **no** — staff session | `rowId`, `action:"assign"`, `identity` | `{ok, outcome}` | Email/phone only — no fuzzy name matching, ever | `app/api/unmatched/resolve/route.ts:35,80` |
| gt.ingest.parked.dismiss | "Close this parked row without counting it" | R / W `unmatched_rows.resolved_by='dismissed'` | **D** | **no** — staff session | `rowId`, `action:"dismiss"` | `{ok, outcome:"dismissed"}` | **The only lossy option, by design** — `revenue_held` is never counted | `app/api/unmatched/resolve/route.ts:36,69` |
| gt.ingest.heatmap.attach | "Attach this heatmap screenshot to that scroll curve" | R `scroll_runs` / W Storage `clarity-heatmaps`, `scroll_runs.heatmap_path` | W | **no** — staff session | multipart `runId`, `file` | `{ok, path}` | Type and size gated (415/413) | `app/api/scroll/heatmap/route.ts:11,71,97` |
| gt.ingest.heatmap.detach | "Remove the heatmap from that scroll run" | R / W `scroll_runs.heatmap_path=null` | **D** | **no** — staff session | `runId` | `{ok}` | Storage object may survive the row edit — not traced | `app/api/scroll/heatmap/route.ts:12,118` |
| gt.meaning.rule.list-rules | "What rules decide Shely's sources?" | R `dimension_values` / none | R | **no** — staff session | `client`, `target?` | `{ok, values[]}` | none | `app/api/rules/route.ts:42,54` |
| gt.meaning.rule.propose-rules-from-data | "What sources exist in Shely's data that no rule names?" | R `v_ads`,`v_events`,`fo_resolve` / none | R | **no** — staff session | `client`, `target` | `{proposals[], scanned, truncated}` | Scan capped at 200 distinct; `truncated` is the only signal | `app/api/rules/propose/route.ts:23,45` |
| gt.meaning.rule.create-rule | "Add an Affiliate source matching source column = affiliate_partner" | R / W `dimension_values` | W | **no** — staff session | `client_id`,`target`,`key`,`rules[]`,`label?`,`ord?` | `{ok, value}` | **Restates every past round immediately** — nothing is re-imported | `app/api/rules/route.ts:62,99,112` |
| gt.meaning.rule.delete-rule | "Delete the Affiliate source rule" | R / W `dimension_values` (delete) | **D** | **no** — staff session | `id` | `{ok, deleted}` | Refuses to delete the last catch-all (409) | `app/api/rules/route.ts:116,130` |
| gt.meaning.schema.push-schema | "Replace Shely's funnel stages with this list" | R `fo_unknown_dimensions`,`fo_unknown_metrics`,`client_flags` / W `client_journey_config` **(delete+insert)**, `client_flags.currency` | W | yes — integration key | `clientId`,`clientName`,`stages[]`,`generatedAt`,`schemaVersion`,`currency?`,`createClient?` | `{ok, created, stagesWritten, pricesPreserved[], dimensionsPreserved[], rateLabelsPreserved[]}` | **Wholesale replace**, slug-keyed preservation of three fields; stale push refused by `generatedAt` (409). ⚠️ **Slug-keyed preservation is known-broken, and the fix is ON HOLD** — AcqOS assigns slugs by POSITION, so a funnel edit moves a stage's price onto a different stage and the push still returns `written:true`. Blocked because AcqOS has no stable stage identity to key on; minting one is a scope decision. The response now carries `slugsMoved[]` so a bad push is at least **loud** — but empty is not a guarantee, it only compares names. See `docs/SLUG-IDENTITY-PROPOSAL.md`. See overlap 5 | `funnel-schema/route.ts:144,161`; `migrations/0040_a_push_keeps_the_breakdown_and_the_label.sql:84,112` |
| gt.read.series.read-exposed-cut | "Give me Shely month by month" | R `fo_cut` over 8 views / none | R | yes — **read-only key** | `clientId`,`cut` ∈ month/week/round/ad/adset/source/offer/roundsource, `from?`,`to?`,`product?`,`channel?`,`offer?` | rows of `{cut_key, cut_label, m}` | Only 8 of ~14 UI cuts are exposed | `app/api/integration/series/route.ts:27,45` |
| gt.read.series.read-landing-page-cut | "Compare Shely's landing pages" | R `v_metrics_by_lp` via `fo_cut` / none | R | **no** — no route exists | client + filters (UI) | table | **UI only** — absent from the `VIEWS` map | `lib/funnel/data.ts:484`; `series/route.ts:27` |
| gt.read.series.read-class-variant-cut | "Compare Shely's class variants" | R `v_metrics_by_variant` / none | R | **no** — no route exists | client + filters (UI) | table | **UI only** | `lib/funnel/data.ts:493` |
| gt.read.series.drill-into-asset | "Show me that one creative round by round" | R `v_metrics_by_*_round` (4 views) / none | R | **no** — no route exists | client + asset (UI) | table | **UI only**; may be 4 leaves not 1 — see `unsure` | `lib/funnel/data.ts:473-476` |
| gt.read.period.read-round-insight | "What happened in round 0926-01?" | R `fo_cut`,`v_round_assets`,`v_scroll_runs`,`rounds`,`period_insights` / none | R | yes — **read-only key** | `clientId`,`roundId?`,`product?`,`channel?`,`objective?`,`frozen?`,`version?` | steps, moves, diagnosis, `versions[]` | No `roundId` means "most recent round"; incompatible with `frozen=only` (400) | `round-insight/route.ts:37,225,241` |
| gt.read.period.read-month-insight | "What happened in September for Shely?" | R `fo_cut`,`v_products`,`v_client_channels`,`v_round_assets`,`period_insights` / none | R | yes — **read-only key** | `clientId`,`month` YYYY-MM,`product?`,`objective?`,`frozen?`,`version?` | month narrative, per-product, per-channel, rounds, weeks | `channel` is **refused** here (400), unlike round-insight | `month-insight/route.ts:43,56,94` |
| gt.read.account.read-actuals | "What are Shely's totals for this window, and is the data complete?" | R `fo_cut`,`rounds`,`client_journey_config`,`v_import_status`,`fo_unmatched_cut` / none | R | yes — **read-only key** | `clientId`,`from`,`to`,`product?`,`channel?` | totals, stages, coverage, unmatched | `offer` refused (400); 404 on unknown client | `actuals/route.ts:37,48,74,87` |
| gt.read.account.list-periods | "Which months may I report on for Shely?" | R `v_round_period`,`v_import_status`,`client_journey_config` / none | R | yes — **read-only key** | `clientId` | `{finalPeriods[], periods[{period,status,reason,rounds,roundCodes,completeThrough}]}` | **There is no `finalised` column** — status is derived from round end dates vs import reach, so it can change when someone re-imports. `incomplete` (waiting on an import) and `open` (waiting on the calendar) are not interchangeable. 503 until `v_round_period` migration is run | `app/api/integration/periods/route.ts`; `lib/integration/periods.ts` |
| gt.read.forms.read-answer-split | "What did Shely's leads say their profession was?" | R `v_form_answer_split` / none | R | **no** — no route exists | client (UI) | question → answer → leads | **UI only** | `lib/funnel/data.ts:807` |
| gt.record.frozen.freeze-round | "Keep this round's reading as it stands today" | R `period_insights`,`rounds` / W `period_insights` (new version) | W | yes — integration key | `clientId`,`roundId`, body `{replace?, force?, frozenBy?, note?}` | `{version, supersededVersion, isFirst}` | Refuses an unfinished round unless `force:true` (422); re-freeze needs `replace` else 409 | `round-insight/route.ts:268,286,289` ⚠️ **409 `period_not_final`** when the data stops before the period does — `force` does NOT override it, `acknowledgeStale: true` does. See `docs/FREEZE-GUARD-CONTRACT.md` |
| gt.record.frozen.freeze-month | "Keep August's reading as it stands today" | R `period_insights` / W `period_insights` | W | yes — integration key | `clientId`,`month`, same body | `{version, supersededVersion}` | same closure rule | `month-insight/route.ts:271` ⚠️ **409 `period_not_final`** when the data stops before the period does — `force` does NOT override it, `acknowledgeStale: true` does. See `docs/FREEZE-GUARD-CONTRACT.md` |
| gt.record.frozen.read-frozen-version | "Give me exactly the v2 reading of that round, not a live one" | R `period_insights` / none | R | yes — **read-only key** | `clientId`,`roundId`/`month`,`frozen=only`,`version=N` | stored payload + `versions[]` | `frozen=only` needs an explicit period id (400) | `round-insight/route.ts:225,241` |
| gt.governance.contract.read-refusals | "What can a write call refuse with, and what do I do about each?" | R none (static) / none | R | yes — **read-only key** | none | `{contractVersion, stability, refusals:{code:{status,recover,retry,means}}}` | **Additive-only, and enforced** — `scripts/test-refusals.mts` pins every code/status/recover as literals, so a rename fails a test rather than a caller (tsc alone does not catch it; verified). **Assert on `contractVersion`; branch on `recover` or `code`, never the status** | `app/api/integration/refusals/route.ts`; `lib/integration/codes.ts` |
| gt.governance.handle.claim-handle | "Reserve the handle acme_fitness for this AcqOS client" | R `client_flags`,`lib/integration/claim.ts decideClaim` / W `client_flags.source_client_id`,`claimed_at` | W | yes — integration key | `clientId` slug `^[a-z0-9_-]+$`, `sourceClientId` uuid **required** | `{claimed, adopted}` or `{alreadyYours}` | **Two 409s wanting opposite things** — branch on `code`, never status | `client-handle/route.ts:112,121,129,149` |
| gt.governance.login.grant-login | "Give jane@acme.com access to acme_fitness and send me the link" | R `client_flags`,`client_journey_config`,auth users / W `auth.users`,`app_users`,`client_users` | W | yes — integration key | `email`,`clientId`,`sourceClientId?` | `{created, signInLink, linkError}` | `signInLink:null`+`linkError` means *retry the link* — the grant is already written; magiclink not invite, so retries work | `client-user/route.ts:110,120,153` |
| gt.governance.login.revoke-login | "Take away jane@acme.com's access to acme_fitness" | R auth users / W `client_users` (delete) | **D** | yes — integration key | `email`,`clientId` | `{revoked}` | **Auth user survives on purpose** — AcqOS owns existence, GT owns what they may read | `client-user/route.ts:183` |
| gt.governance.deployment.check-health | "Is GroundTruth up, and which commit is live?" | R env + one Supabase probe / none | R | yes — **no key needed** | none | `{status, checks{supabase,integrationKey,integrationReadonlyKey}, commit, loginRequired}` | Open path by design, so a monitor that cannot sign in can use it | `health/route.ts:51,77,84`; `middleware.ts:73` |
| gt.governance.cache.refresh-cache | "Drop the cache, I just changed something in the database" | none / W Next cache (`FUNNEL_TAG`, `/`) | W | **no** — staff session | none | `{ok}` | Needed after any direct SQL edit; 30-min TTL otherwise | `app/api/revalidate/route.ts:31,42` |
| gt.governance.cache.warm-cache | "Fill the cache before anybody waits on it" | R `client_journey_config`,`rounds`, then getDashboard per combination / none | R | yes — integration key | `clientId?`,`budgetMs?`,`rounds?` | `{warmed, skipped, stoppedBy, slowest[]}` | **Does not make anything faster** — moves the slow read to when nobody is watching (cold 4.14s → warm 0.027s). Serial and budgeted on purpose: nano has timed out on three concurrent reads. `stoppedBy:budget` is normal | `app/api/integration/warm/route.ts` |

---

## 3 · The five lists

### overlaps — leaves that also exist in GU

| GT leaf | GU leaf | Verdict from GT's code |
|---|---|---|
| `gt.read.account.read-actuals` | `gu.integrations.read-actuals` | **Confirmed.** Same call. |
| `gt.read.period.read-round-insight` | `gu.integrations.read-round-insight` | **Confirmed.** Same call. |
| `gt.read.period.read-month-insight` | `gu.reporting.generate-monthly-report` | **Partly refuted — different objects.** |
| `gt.record.frozen.*` | `gu.reporting.list-frozen-rounds` | **Confirmed. Two stores, and GT cannot be enumerated.** |
| `gt.meaning.schema.push-schema` | `gu.strategy.map-stage-to-meta-event` + `gu.integrations.push-funnel-shape` | **Confirmed, and the seam is sharper than GU can see.** |
| `gt.governance.handle.*`, `gt.governance.login.*` | `gu.access.sign-up` / `hand-client-over` | **Confirmed — skills, not plumbing.** |

**Should GT list the two duplicated reads at all? Yes.** The cut is **GT owns the query, GU owns
the wire.** In GT's tree `read-actuals` means *compute this*; in GU's it means *fetch it and put it
somewhere*. If GT stops answering, GT's leaf is **broken** and GU's is **blocked** — different
failures, different owners, different fixes. Merging them would hide which side to go and repair.

**On `generate-monthly-report`.** `month-insight` does not return raw cuts. It returns a narrative:
objective, steps, moves, a diagnosis, per-product and per-channel breakdowns, and the rounds and
weeks inside the month (`month-insight/route.ts:94-158`). So GU is rendering a document from an
analysis GT already performed — **not the same object.** ⚠️ **But** if GU still rolls a month up
out of frozen *rounds*, that is a second arithmetic; `/series` exists because exactly that was
happening, and the route header says so (`series/route.ts:12-22`).

**On `list-frozen-rounds`.** Confirmed: two stores of one object. GT versions readings in
`period_insights`, stamping `attribution_model` and `rule_version` on each so an old report can
still explain itself. ⚠️ **GT has no endpoint that lists frozen periods.** `versions[]` is returned
only for a period you already named, so GU can confirm one at a time and can never enumerate GT's
set. Logged under `gaps`.

**On the two stage definitions — the one GU most wanted.** The reconciliation is **wholesale
replace with three slug-keyed exceptions**:

```sql
delete from client_journey_config where client_id = p_client_id;   -- 0040:112
```

…but `unit_price`, `compare_dimension` and `stage_rate_label` are read out first, keyed by
`stage_slug`, and written back (`0040:84-94`). The response names what survived:
`pricesPreserved[]`, `dimensionsPreserved[]`, `rateLabelsPreserved[]`.

**So it is not "GU owns stages, GT accepts".** GU owns the **list, order and names**; GT owns
**three per-stage attributes GU never sends and cannot see.** ⚠️ **A push that renames a
`stage_slug` silently drops that stage's price and comparison dimension**, because preservation is
slug-keyed. Ordering between the two systems is already contested — a stale push is refused by
`generatedAt` with a 409 (`funnel-schema/route.ts:161`).

**On client identity.** GT keys on a lowercase slug, GU on a uuid, and `client_flags.source_client_id`
binds them with `claimed_at` recording when. Three real leaves, not plumbing — because the refusals
carry decisions: `handle_taken` means *mint another*, `source_holds_other` means *stop and use
`heldHandle`*. A caller branching on HTTP status instead of `code` either loops forever or hands one
client's reporting to another.

### gaps — looks like it should do this, doesn't

- **No "list frozen periods" endpoint.** `versions[]` only for a named period. This is what blocks
  GU's `list-frozen-rounds` from reconciling against GT.
- **No machine-readable contract.** The four refusal codes — `handle_taken`, `source_holds_other`,
  `handle_not_claimed`, `handle_mismatch` — exist **only as string literals in route bodies**. No
  OpenAPI, no JSON schema, no exported constant. GU branches on them and **nothing would catch a
  rename.** ⚠️ Highest-value small fix on this list.
- **No read endpoint for the journey schema.** You can push stages; you cannot fetch them except as
  a side effect of `actuals` or `round-insight`.
- **No endpoint for declared ads measures.** They import and now reach the cut, but `SPINE` is a
  closed `MetricKey` union so no row is ever drawn (`lib/funnel/spine.ts:14`).
- **`client_targets` is empty** (0 rows). Every "vs target" comparison degrades to "no target set".
- **`fo-main` is deleted.** It answered `/api/health` with `{"status":"ok","timestamp":…}` — no
  checks, no commit, no database — while `POST /api/import/commit` reached the handler
  **unauthenticated**, saved only by an unset service-role key. The Vercel project was removed on
  15 Sep; the URL now returns `DEPLOYMENT_NOT_FOUND`. **GU's finding was correct and is closed.**

### blocked — exists in the UI, no machine-reachable path

⚠️ **GU's warning applies here and this list is not empty.** Middleware opens only `/login`,
`/auth/*`, `/api/integration/*` and `/api/health` (`lib/supabase/middleware.ts:62-73`). Every other
route requires a Supabase session cookie via `requireStaff()` — **the integration key does not reach
them, and no key-based door exists.**

**Fourteen leaves, across eight route files, that exist but no key can call:**
`preview-import` · `commit-import` · `discard-staged-import` · `download-template` ·
`accept-best-guess` · `assign-identity` · `dismiss` · `attach` · `detach` · `list-rules` ·
`propose-rules-from-data` · `create-rule` · `delete-rule` · `refresh-cache`
*(`gt.ingest.meta.*` is **not** blocked — it has a second door at `/api/integration/meta-pull`.)*

**Four capabilities with no route at all — UI-only reads:**
`read-landing-page-cut` · `read-class-variant-cut` · `drill-into-asset` · `read-answer-split`.
These render from `fo_cut` inside a server component; `/series` exposes 8 of ~14 cuts and none of
these four.

**What is missing, precisely:** either those routes accepting `INTEGRATION_SHARED_KEY`, or a service
account holding a real staff session. `requireStaff()` also **passes everyone** when
`FUNNEL_REQUIRE_LOGIN` is unset — production has it set to `1`, so enforcement is live
(`health` reports `loginRequired: true`).

### unsure — inferred, not read end-to-end

- **Whether `runPull` actually reaches Meta.** I read the route and the writes
  (`lib/meta/pull.ts:161,177`) but not the Graph API call, and did not run one.
- **Whether detaching a heatmap deletes the storage object** or only nulls the path. I read the row
  update; I did not follow the storage call in `DELETE`.
- **The exact `stages[]` payload shape** for `push-schema` — I read the route and the SQL function,
  not `lib/integration/schema.ts`'s validator in full. Inputs may be wrong in detail.
- **`drill-into-asset` as one leaf or four.** Four `*_round` views back it; the UI presents it as one
  gesture. I cut it as one — **if they are genuinely four skills the tree is wrong here** by rule 4.
- **Whether `gt.ingest.meta.*` is one leaf with two doors or two leaves.** Two routes, same
  `runPull`, different auth and different rate limiting. I treated the auth difference as
  non-defining. Arguable.
- **Every GU-side claim.** I read GU's skill tree file, not GU's code.

### not-read — parts of the repo I did not open

- `lib/funnel/analysis.ts`, `diagnose.ts`, `chart.ts`, `cadence.ts`, `wire.ts` — the reasoning behind
  the insight leaves.
- `lib/integration/schema.ts`, `lib/integration/insight.ts` — validation and narrative assembly.
- `lib/meta/pull.ts` beyond the two writes.
- Most of `components/**` — I read `Shell`, `ScrollPanel`, `RulesPane`, `AcqosPane` and
  `DataPanes` only.
- **All 119 migration bodies** except the ~8 cited. The migration headers are GT's real design
  record and I sampled them.
- `scripts/**`, `supabase/migrations/ALL.sql`.
- **Pages: I did walk them** — `/`, `/login`, `/auth/set-password`, plus `app/actions/acqos.ts` (the
  only server-action file). That file's two actions call GT's own HTTP routes rather than the
  database, so they add no leaves.

---

**Total leaf count: 35.** — Ingest 11 · Meaning 5 · Read 9 · Record 3 · Governance 7.
**Machine-reachable: 17. Blocked: 18.**

> Two leaves added on 15 Sep, both callable: `read.account.list-periods` (which months may be
> reported on) and `governance.contract.read-refusals` (the four refusal codes, served from the
> constant the routes throw rather than described in prose). The blocked count did not move.

⚠️ **18 of 35 are not machine-reachable.** For a skill tree, that is the headline number rather
than the 35: over half of GT's capability is behind a browser session or has no route at all. GU
reported 83 leaves with `blocked` empty; GT reports 35 with `blocked` at 18. **The asymmetry is
real, not a difference in how carefully we each looked** — GU's operator surface is key- or
cron-reachable, and GT's is not.
