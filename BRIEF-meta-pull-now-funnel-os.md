# Brief — "Pull now" for Funnel OS

**Supersedes** `acq-os/FUNNEL-OS-BRIEF-meta-pull-now.md` for anything built in this repo.

That brief is good and its traps are real — several were confirmed independently while
reconciling Shely's May–August data. **Read it for §5.** But it was written against AcqOS's
data model, and four of its assumptions do not hold here. This document is the Funnel OS
version: same feature, this app's schema, this app's rules.

---

## 1. What you're building

A **Pull now** button that fetches a client's latest Meta ad numbers on demand, writes them
into `ads_performance`, and re-renders so the operator sees fresh figures without waiting for
an export to be downloaded and dropped on the Import tab.

**Read-only.** Insights endpoints, `ads_read` scope. Nothing on the ad account is created,
paused or modified. Say so on the button.

---

## 2. What Funnel OS actually stores — the AcqOS brief has this wrong

There is **no per-stage snapshot table** and there are no stages holding numbers. Stages are
*derived* by 29 views from two fact tables. Ads land in exactly one place:

```sql
ads_performance(
  id, round_id → rounds(round_id), date, campaign, ad_set, ad,
  spend, impressions, reach, clicks, import_batch_id → import_batches(batch_id)
)
```

No `captured_at`, no snapshots, no time series. **One row per ad per day.** Ignore §6 of the
AcqOS brief entirely.

### Idempotency is already solved

The pipeline's ads dedupe key is `round_id|date|campaign|ad_set|ad` (`lib/import/pipeline.ts`,
~line 492). Reuse it. It gives exactly the property §6 asks for, so the deliberate overlapping
window from trap 5.1 is safe: pull the same day twice and the second write is a no-op.

**Write through the existing pipeline, not around it.** A pull should produce an
`import_batches` row like any other import so the Import tab's freshness and coverage
reporting keeps working. A pull that bypasses the batch table is a pull the staleness header
cannot see.

---

## 3. The two questions from the review — answered

### 3.1 Auth: already built, use it

The AcqOS brief specifies session auth and per-tenant 403s. **Funnel OS has no login and this
is deliberate — do not add one.** The integration already solved this:

- Header `x-integration-key`, compared with `timingSafeEqual` — `lib/integration/auth.ts`
- `401` on mismatch, **`503` when `INTEGRATION_SHARED_KEY` is unset** — different faults,
  different fixes, and a bare 401 for both leaves the person wiring it up stuck
- Secret lives on Vercel marked Sensitive, not in `.env.local`

Use the same helper. Do not invent a second auth scheme.

> The real exposure is not data — reads are already public. It is that **this endpoint spends
> a Meta token**. Unprotected, anyone with the URL burns your rate limit. That is what the key
> is for here.

**Also add a cooldown.** A human leaning on the button must not fan out to the Graph API. Refuse
a pull for the same client within N seconds and say so plainly.

### 3.2 Rounds: NOT answered by the integration — decide this first

`ads_performance.round_id` is a foreign key. Meta returns campaigns; it has never heard of a
round. Today `roundFromCampaign` (`lib/import/attribute.ts:122`) matches by substring —
`DF_SG_Preview_Sprint1_0526_02` contains `0526-02` once underscores become hyphens.

**Rounds are still created by hand as a SQL insert. There is no screen and no API.** I checked:
`/api/integration/actuals` only *reads* rounds; nothing creates them.

So *Pull now* on a live campaign whose round does not exist writes nothing — **and "now" is
precisely when a round is newest.** That is the main use case failing.

Two options. **Pick one before writing code:**

| | Behaviour | Cost |
|---|---|---|
| **A — Refuse and say which** *(recommended)* | Rows whose campaign maps to no round are not written; the response names the campaign and the missing round | Small. Honest. Also serves as the provenance rule — a campaign nobody mapped is a campaign nobody asked us to manage |
| **B — Let AcqOS open the round** | Extend the schema push so AcqOS can create rounds, mirroring `0036 a_push_can_open_a_client` | Bigger, but AcqOS is the planner and already knows the dates. This is where it should end up |

**A now, B next.** A is the provenance rule the AcqOS brief asks for in §7 — its
`system_launched_at` check has no equivalent here, because AcqOS creates campaigns and Funnel
OS does not. "Maps to a known round" satisfies both the provenance rule and the foreign key
with one condition.

---

## 4. Two Graph calls, not one — reach is why

The AcqOS brief specifies a single ad-level request. **That cannot produce a correct reach for
this app**, and it omits `reach` from its field list entirely.

`0016_reach_is_not_additive.sql` exists because reach counts **distinct people** and does not
sum. Measured on real data:

> `DF_SG_Preview_Sprint1_0526_02` — its six ad sets sum to **20,665**.
> The campaign's own row says **11,380**.
> Adding the ad-set rows overstates by **82%**, and drags Frequency with it.

The rule the views apply:

```sql
coalesce(sum(reach) filter (where nullif(btrim(ad_set), '') is null), sum(reach))
```

**A row naming no ad set is a coarser, already-deduplicated measurement and wins.** The current
data only reconciles because the loaded CSV carries 11 `ALL CAMPAIGNS` rows serving exactly this
purpose.

### Call 1 — ad level

```
GET /v21.0/act_<AD_ACCOUNT_ID>/insights
  level=ad
  time_increment=1
  time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
  limit=200
  fields=ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,
         spend,impressions,clicks,inline_link_clicks,outbound_clicks,account_currency
```

Drop `breakdowns` — Funnel OS needs daily granularity, not hourly. **That also retires trap
5.5** (the advertiser-timezone hour), because there is no hour to mislabel. Dates still need
care: bucket by the ad account's local day, matching `localDay` / `sgDayOf` in the pipeline.

Drop `actions` and `action_values` — see §5.

### Call 2 — campaign level, for reach only

```
GET /v21.0/act_<AD_ACCOUNT_ID>/insights
  level=campaign
  time_increment=1
  time_range=<same>
  fields=campaign_name,reach
```

Write these as rows with **`ad_set` and `ad` null**, which is what `0016`'s rule keys on. Leave
`reach` null on the ad-level rows — do not write a per-ad reach that must never be summed.

> `0016` also notes what neither call can fix: when two campaigns run in one round, their reach
> rows overlap and cannot be added either. `0526-03`'s two campaigns report 7,902 and 4,863
> against a true 10,131. If a round has multiple campaigns, its reach is still an over-count.
> **Say so on screen rather than pretending otherwise.**

### Pagination

Follow `paging.next` until absent.

> ⚠️ **`paging.next` carries the access token in the query string.** AcqOS leaked a live token
> this way. Strip `access_token` before anything reaches a log, an error message, or a response
> body.

### Where the ad account id lives

**Nowhere yet.** `source_ref` on `client_journey_config` holds *field names* (`impressions`,
`outbound_click`), not account identifiers. You need a per-client Meta ad account id. Add it as
a client-level setting; do not overload `source_ref`, which already means something else.

---

## 5. What this must NEVER write

The AcqOS brief §2 says Meta owns the top of the funnel "including the platform's own lead
count". **In Funnel OS that is wrong and it matters.**

| | Why not |
|---|---|
| **Leads** | Leads are `events` rows from GoHighLevel with identity resolution, attribution and a dedupe key. Meta's lead count is a different number arrived at a different way. Writing it creates two conflicting lead figures, and every downstream rate — attendance %, purchase %, CPL — is built on the CRM one |
| **Conversions / purchases** | Funnel OS counts purchases from the payments file. ROAS here means *what the advertising produced, measured against real sales* — not Meta's attributed conversions. **Cut §5.3 and §5.4 with this**, and the two hardest traps go with them |
| **Budgets** | No column. **Cut §5.8 and §5.9** |
| **Anything below the ad** | Attendance, sales, appointments. CRM and payments own these |

**What it writes: `spend`, `impressions`, `clicks` at ad level, and `reach` at campaign level.
That is the whole surface.**

Note `client_journey_config` declares `Leads → source_type: meta, source_ref: lead` for Shely.
That declaration describes where AcqOS *thinks* the number comes from. **It is not permission
to overwrite the CRM lead count.**

---

## 6. The clicks conflict — resolve before writing a single click

AcqOS has declared, in Shely's pushed schema:

```
Landing Page Clicks → source_type: meta, source_ref: outbound_click
```

But **Funnel OS's loaded data uses Meta's Link clicks throughout**, deliberately. From today's
reconciliation:

> Clicks +24 — the sheet changes column in August. May–July uses **Link clicks**; August
> switches to **Outbound clicks**. Ground Truth uses Link clicks throughout, because CTR is
> only comparable between a June audience and an August one if it is the same measurement both
> times.

So the declaration and the data disagree about what "clicks" means. The two differ by a lot on
engagement-heavy creative.

**A pull that follows the declaration silently restates 4,881 clicks and every CTR and CPC
built on them.** Decide which is authoritative, apply it to the whole history, and write the
decision down. Do not let a pull quietly change the definition of a metric that is already
reconciled.

Request `clicks`, `inline_link_clicks` and `outbound_clicks` all three and map deliberately —
`outbound_clicks` lives inside the `actions` array, not as a top-level field.

---

## 7. The traps that still apply

From the AcqOS brief, with Funnel OS specifics:

- **5.1 — `since`/`until` are both INCLUSIVE.** Fetch a deliberately overlapping window; the
  dedupe key makes overlap free.
- **5.2 — `time_increment=1` is MANDATORY.** Without it a multi-day range returns one date
  stamped on every row. It cost AcqOS two live incidents and produced data that looked present
  and was worthless. **Acceptance test 2 exists for this.**
- **5.6 — Meta OMITS null fields.** An absent key and a zero are different facts. This is
  already Funnel OS's standing rule — *blank is never zero, anywhere in the app*. A stage with
  no Meta mapping renders `—`, never `0`. Note `ads_performance` columns currently
  `default 0`; a pull must not turn "Meta did not report this" into a measured zero.
- **5.7 — three click metrics, none interchangeable.** See §6.

Retired here: **5.5** (no hourly breakdown), **5.3/5.4/5.8/5.9** (no conversions or budgets).

---

## 8. Route contract

```
POST /api/integration/meta-pull    { clientId: string, since?: string, until?: string }
Header: x-integration-key: <secret>
```

Under `/api/integration/` because that is where shared-key routes live and where the auth
helper already is.

- **`401`** key mismatch · **`503`** key unconfigured · **`400`** unknown `clientId`
- **`429`** inside the cooldown, with the seconds remaining
- Client id comes from the body — there is no session. The shared key authorises naming it.
  **Validate the client exists before writing anything.**
- One campaign's failure must not block the others. Catch per campaign, collect, carry on.

Three outcomes, and they must be distinguishable — *a query that failed must never look like a
query that found nothing*:

| State | Response |
|---|---|
| Nothing to pull | `200 { ok: true, pulled: [], note: "..." }` |
| Some campaigns threw | `200 { ok: true, ..., anyFailed: true }` |
| Every campaign threw | `502 { ok: false, error: "all_pulls_failed" }` |

Coded errors only. Never raw database or Graph text in a response.

**Response must also report what it refused**, per §3.2 option A:

```jsonc
{ "ok": true,
  "pulled":  [ { "campaign": "DF_SG_..._0926_01", "round": "0926-01", "rows": 41, "written": 41 } ],
  "skipped": [ { "campaign": "DF_MY_..._1026_01", "reason": "no_round_for_campaign" } ],
  "anyFailed": false }
```

Silence about a skipped campaign is the failure mode that matters — it reads as success.

---

## 9. Button

- Disabled in flight, spinner, "Pulling the latest…"
- On success re-render so the numbers actually change
- **Treat `anyFailed: true` as a failure even on a `200`** — otherwise a pull that wrote nothing
  renders clean and the operator trusts stale numbers
- **Show `skipped` prominently.** "3 campaigns had no round" is the most useful thing this
  button can tell anybody
- Plain-language errors. No Graph codes, no stack traces
- Hint text saying it is read-only

---

## 10. Acceptance tests

1. Press twice → row count unchanged, values identical. *(idempotency)*
2. Pull a 5-day range → rows carry **5 distinct dates**. *(trap 5.2)*
3. A campaign matching no round → **not written**, named in `skipped`, everything else still
   written. *(§3.2)*
4. Reach: ad-level rows carry `reach` null; campaign-level rows carry it with `ad_set` null.
   A round's reach reads the campaign row, **not the sum of its ad sets**. *(0016)*
5. Meta omits a field → stored null, renders `—`. Grep the output for a stray `0`. *(trap 5.6)*
6. Bad key → `401`. Unset key → `503`. Unknown client → `400`. Second press inside the
   cooldown → `429`.
7. Revoked token → friendly error, nothing written, no 500.
8. Grep all logs and responses for `access_token` → no hits. *(§4)*
9. **A pull that overlaps already-loaded history leaves Shely's reconciled figures unchanged:**

   | | |
   |---|---|
   | Spend | $16,538.10 |
   | Impressions | 318,409 |
   | Clicks | 4,881 |
   | Reach (0526-02) | 11,380 — **not** 20,665 |
   | Leads | 1,349 |
   | Total revenue | $81,942 |
   | ROAS | 2.11 |

   **If any of these move, the pull is wrong.** They were reconciled against the client's own
   master sheet on 4 September and are correct. Test 9 is the one that catches the most.

---

## 11. Constraints

- **Never run SQL against the database.** Deliver `.sql` files; the developer runs them.
- Migrations re-runnable; `ALL.sql` appended surgically.
- **Never put fixture or test data on `shely`.** It is a real client whose figures are
  reconciled. Use a demo client.
- Do not touch `northsea_supply` or `DEMO-W1`–`W4`.
- Token never reaches the browser, a log, or a response body.
- `npm run lint` is not configured. Use `npx tsc --noEmit` and `npm run test:import`
  (currently **449 passing**).
- Commit messages: plain sentence, no `feat:` prefix.

---

## 12. Out of scope

- Any Meta write. Read scopes only.
- Backfill. This is "now". A backfill needs its own window handling and hits rate limits
  differently.
- Scheduling. A nightly version later calls the same ingest function from a different trigger —
  **do not build two ingest paths.**
- Leads, conversions, budgets, and every CRM stage. See §5.
