# Native Data Integration (API) — build brief

**Status:** not started. This document is a specification to hand to a builder. Nothing in it has been implemented.

**Scope:** a two-way HTTP API between the two applications.

| Name in this doc | Also called | Repo | Role |
|---|---|---|---|
| **Ground Up** | AcqOS | `acq-os` | The planner. Runs the client discovery form, decides what the funnel steps *are*, plans spend, simulates outcomes. |
| **Ground Truth** | Funnel OS | `funnel-os` | The scorekeeper. Ingests real exports (ads, leads, attendance, sales), resolves identity, and reports what actually happened against those steps. |

Previously this was described as "dynamic data integration". Call it **Native Data Integration (API)** — "native" meaning the two apps talk directly over an API instead of a human copying a schema from one into the other by hand.

---

## 1. Why this exists

Today Ground Truth's funnel steps for a client are typed in by hand as rows in a database table. That does not scale past one client, and the person doing the typing has to already know what a performance-marketing funnel looks like.

Ground Up already solves that half: it interviews the client and produces the ordered step list. So:

- **Ground Up owns the *shape* of the funnel.** Which steps exist, their order, their names, what kind of number each step is, and where that number is supposed to come from.
- **Ground Truth owns the *values*.** What actually happened, per step, from real data, with real identity resolution and real attribution.

Neither app should duplicate the other's half. That is the whole design rule.

---

## 2. The two directions

### Direction A — Ground Up → Ground Truth: **push the schema**

Ground Up sends the funnel definition for a client. Ground Truth stores it and immediately starts reporting against those steps.

Trigger: whenever a client's funnel plan is created or edited in Ground Up.

### Direction B — Ground Truth → Ground Up: **pull the actuals**

Ground Up asks Ground Truth "what really happened for this client between these dates?" and gets back the measured value for each step it defined.

Trigger: whenever Ground Up renders a plan-vs-actual view, or recalculates a projection from real performance.

**Direction B is a pull, not a push.** Ground Truth should not fire numbers at Ground Up on ingest. Numbers in Ground Truth change on every import, every re-import, and every unmatched-row resolution; pushing each change would be noise. Ground Up asks when it needs to know.

---

## 3. Authentication

**Ground Truth has no login. This is deliberate, not a defect — do not add one.**

So the API routes are protected by a shared secret, not by a user session:

- Header: `x-integration-key: <secret>`
- Stored as an environment variable on both sides (`INTEGRATION_SHARED_KEY`). On Vercel, not in local `.env.local`.
- Compare with a timing-safe equality check, not `===`.
- Reject with `401` and no body detail on mismatch.

Both endpoints are **server-side routes only**. They use the Supabase service-role key. That key must never reach the browser.

Note for the builder: the AcqOS mapping document specifies "the tenant ID must come from the authenticated session, never from the request body." That rule cannot apply here — there is no session. The client ID therefore *does* come from the body, and the shared key is what authorises the caller to name it. Validate that the client ID exists before writing anything.

---

## 4. Direction A: the schema push

### 4.1 Endpoint

```
POST /api/integration/funnel-schema     (on Ground Truth)
```

### 4.2 Payload

```json
{
  "clientId": "shely",
  "clientName": "Shely",
  "clientNote": "Webinar → offer · 6 stages",
  "createClient": false,
  "source": "acqos",
  "schemaVersion": 1,
  "generatedAt": "2026-08-24T09:00:00+08:00",
  "stages": [
    {
      "order": 1,
      "slug": "targeting",
      "name": "Targeted views",
      "metric": "impressions",
      "sourceType": "meta",
      "sourceRef": "impressions",
      "compareDimension": "ads_performance.ad_set",
      "rateLabel": null,
      "unitPrice": null
    },
    {
      "order": 2,
      "slug": "ads",
      "name": "Clicked the ad",
      "metric": "clicks",
      "sourceType": "meta",
      "sourceRef": "outbound_click",
      "compareDimension": "ads_performance.ad",
      "rateLabel": "CTR",
      "unitPrice": null
    },
    {
      "order": 3,
      "slug": "lp",
      "name": "Signed up",
      "metric": "leads",
      "sourceType": "crm",
      "sourceRef": "lead_at",
      "compareDimension": null,
      "rateLabel": "Lead Gen %",
      "unitPrice": null
    },
    {
      "order": 4,
      "slug": "class",
      "name": "Attended the class",
      "metric": "attendance",
      "sourceType": "csv",
      "sourceRef": "attendance",
      "compareDimension": "rounds.session_label",
      "rateLabel": "Show-up rate",
      "unitPrice": null
    },
    {
      "order": 5,
      "slug": "preview",
      "name": "Bought the preview",
      "metric": "preview_purchases",
      "sourceType": "csv",
      "sourceRef": "sales",
      "compareDimension": "events.round_id",
      "rateLabel": "Close rate",
      "unitPrice": 297
    }
  ]
}
```

### 4.3 Field rules

| Field | Rule |
|---|---|
| `clientId` | If it already exists, this replaces that client's funnel. If it doesn't, the push is rejected **unless** `createClient` is `true`. |
| `clientNote` | Optional subtitle shown in the client switcher. Omitted or `null` keeps whatever is stored — which for a client being opened is nothing. |
| `createClient` | Optional boolean, default `false`. The caller asserting it means to **open a client that does not exist yet**. Sending it for a client that already exists is not an error (a retried push must not fail); it replaces the funnel and reports `created: false`. |
| `order` | Integer, 1-based, contiguous, unique within the payload. Gaps or duplicates reject the whole payload. |
| `slug` | Durable identifier for the step. Survives renaming and reordering. Lowercase, hyphenated. **Unique within the payload** — the primary key is `(client_id, stage_order)`, so the database would accept a repeat, and `unit_price` preservation keys on the slug. |
| `name` | Human label shown in the UI. Free text. |
| `metric` | **Must be one of Ground Truth's known metric keys.** See §4.4. An unknown value rejects the whole payload — never silently store it. |
| `sourceType` | `"meta" \| "google" \| "crm" \| "csv"` — where this number comes from. See §4.5. |
| `sourceRef` | The specific field/metric/event name within that source. Free text, validated per `sourceType` only loosely. |
| `compareDimension` | Which column this stage can be broken down by, as `table.column`. `null` is legal and means "this stage has no breakdown". |
| `rateLabel` | Label for the conversion rate *into* this stage, e.g. `"Lead Gen %"`. `null` means no rate shown. |
| `unitPrice` | Money per unit for revenue stages. `null` for non-revenue stages. **`null` and `0` are different.** |

### 4.4 The `metric` whitelist

Ground Truth's stage→metric resolution is a `case` expression in SQL, not free text. The authoritative list of accepted values is:

- the `case j.stage_metric when ... end` block in `supabase/migrations/0031_the_journey_strip_respects_the_filter.sql`
- cross-checked against the `MetricKey` union in `lib/funnel/spine.ts`

**Read both files before writing the validator.** Do not hardcode a list from this brief — it will drift. Reject any `metric` not present in the SQL case expression, and say which value was rejected in the error response.

If Ground Up needs a metric Ground Truth doesn't have, that is a schema change in Ground Truth (a new migration extending the case expression), not something the API should route around.

### 4.5 `sourceType` — the new field

This is the one genuinely new column. It records where a stage's number comes from:

- `meta` — read from the Meta Ads API
- `google` — read from Google Ads
- `crm` — read from the CRM (GoHighLevel)
- `csv` — read from an uploaded export file

Right now **every** number in Ground Truth arrives via `csv`, so on day one this field will say the same thing on every row. It earns its keep once native Meta/CRM reads land — at that point the app needs to know, per stage, whether to look in the imported tables or call an API.

### 4.6 Storage

Ground Truth already has the table this belongs in: `client_journey_config` (see `supabase/migrations/0001_schema.sql`). Its current shape:

```sql
create table client_journey_config (
  client_id         text not null,
  stage_order       integer not null,
  stage_name        text not null,
  compare_dimension text,
  primary key (client_id, stage_order),
  client_name       text,
  client_note       text,
  stage_slug        text,
  stage_metric      text,
  stage_rate_label  text,
  unit_price        numeric(12,2)
);
```

**Do not create a second `stage_source_map` table.** `client_journey_config` already is that table under a different name; a parallel table would give the app two contradictory answers about what the funnel is.

Additive migration required:

```sql
alter table client_journey_config
  add column source_type   text,
  add column source_ref    text,
  add column schema_source text,          -- 'acqos' | 'manual'
  add column synced_at     timestamptz;

alter table client_journey_config
  add constraint client_journey_config_source_type_chk
  check (source_type is null or source_type in ('meta','google','crm','csv'));
```

`source_type` is nullable on purpose — existing hand-typed rows have no answer yet, and **blank is not `'csv'`**. Backfill deliberately later if wanted; do not default it.

### 4.7 Write semantics

The push is a **full replacement of one client's funnel**, transactional:

1. Validate the entire payload first. Any single failure rejects everything — nothing partial is written.
2. Check whether the client exists. If not, require `createClient: true` or return `404`.
3. In one transaction: delete existing `client_journey_config` rows for that `client_id`, insert the new set.
4. Stamp `schema_source = 'acqos'` and `synced_at = now()` on every inserted row.

There is **no `clients` table** in this schema — `client_journey_config` is the register, and `v_clients` (what the switcher reads) is built from it. So inserting stage rows for an unknown `client_id` is what creating a client *means* here. That is why creation has to be asserted rather than inferred.

Rationale: a step-by-step upsert keyed on `stage_order` cross-wires silently when Ground Up reorders steps. If step 3 and step 4 swap places, an index-keyed upsert quietly attaches step 3's mapping to step 4's name. Replace-all cannot do that.

**But replace-all must not erase what Ground Up doesn't know.** Funnel OS holds Shely's preview price at `297`; AcqOS has no idea. A literal replace would blank it, and `fo_metrics` reads `p_preview_price` straight out of this table, so `prevPrice` and `prevAov` would vanish with nothing said. Two values are therefore carried across the replace:

- `client_note` — preserved.
- `unit_price` — preserved **per `stage_slug`** when the incoming stage sends `unitPrice: null`. An explicit price wins. An explicit `0` is a price, not an absence, and stays `0`.

Preserved prices are named in the response so the caller knows the stored funnel is not byte-for-byte what it sent.

Keep `slug` stable across pushes anyway — it is what lets anything downstream (saved views, notes) survive a reorder.

### 4.8 Response

```json
{ "ok": true, "clientId": "shely", "created": false, "stagesWritten": 5, "pricesPreserved": ["preview"], "syncedAt": "2026-08-24T09:00:01+08:00" }
```

### 4.9 Ordering: a late push cannot undo a newer one

`schemaVersion` and `generatedAt` are stored on every row. A push whose `generatedAt` is **strictly older** than the one already stored for that client is refused with a `409` and **writes nothing**:

```json
{
  "ok": false,
  "error": "stale push: a newer funnel is already stored for this client",
  "storedGeneratedAt": "2026-08-24T10:00:00+08:00",
  "incomingGeneratedAt": "2026-08-24T09:00:00+08:00"
}
```

An **equal** `generatedAt` is allowed through. A retry carries the same timestamp as the attempt it is retrying, and a sender that cannot safely replay its own message is worse off than with no guard; the replace is idempotent, so a duplicate landing costs nothing.

The check runs inside the same transaction as the write, not in the route. A route-level read-then-write would lose the race between two concurrent pushes — which is the exact case the guard exists for.

**Ground Up must not retry a 409.** It is a refusal, not a failure: the funnel on file is newer than the one being sent, and resending will never succeed. Regenerate and push with a current `generatedAt` instead.

### 4.10 Rejection format

On a validation failure, `400` with every problem listed at once, not just the first:

```json
{
  "ok": false,
  "errors": [
    { "stage": 3, "field": "metric", "message": "unknown metric 'signups' — not in the journey-strip case expression" },
    { "stage": 5, "field": "order", "message": "duplicate order 5" }
  ]
}
```

The builder should treat "one clear list of everything wrong" as a requirement, not a nicety. The person reading this error is fixing a client's funnel definition, and round-tripping one error at a time is how a five-minute fix becomes an afternoon.

---

## 5. Direction B: the actuals pull

### 5.1 Endpoint

```
GET /api/integration/actuals?clientId=shely&from=2026-08-01&to=2026-08-31     (on Ground Truth)
```

Optional filters: `product` and `channel`.

**Not `offer`.** These are whole-funnel totals, and `fo_cut` only honours `p_offer` on `v_metrics_by_offer` — passing it here returned the unsplit numbers under a filtered heading. The endpoint now rejects `offer` with a `400`. The preview/middle split is already in the response as the `preview_purchases` and `middle_purchases` stages.

### 5.2 Response

```json
{
  "clientId": "shely",
  "from": "2026-08-01",
  "to": "2026-08-31",
  "filters": { "product": null, "channel": null },
  "coverage": {
    "lastImportedAt": "2026-08-21T22:14:00+08:00",
    "lastObservationDate": "2026-08-18",
    "anySourceStale": true,
    "sources": [
      { "source": "ads",        "importedAt": "2026-08-21T22:14:00+08:00", "coverageStart": "2026-08-01", "coverageEnd": "2026-08-20", "isStale": false, "daysBehind": null },
      { "source": "attendance", "importedAt": "2026-08-21T22:13:10+08:00", "coverageStart": "2026-08-18", "coverageEnd": "2026-08-18", "isStale": true,  "daysBehind": 2 }
    ],
    "roundsInWindow": ["0826-01"]
  },
  "stages": [
    { "order": 1, "slug": "targeting", "metric": "impressions",        "value": 41230,  "sourceType": "csv" },
    { "order": 2, "slug": "ads",       "metric": "clicks",             "value": 1840,   "sourceType": "csv" },
    { "order": 3, "slug": "lp",        "metric": "leads",              "value": 212,    "sourceType": "csv" },
    { "order": 4, "slug": "class",     "metric": "attendance",         "value": 37,     "sourceType": "csv" },
    { "order": 5, "slug": "preview",   "metric": "preview_purchases",  "value": null,   "sourceType": "csv" }
  ],
  "parked": {
    "count": 4,
    "reasons": { "no_matching_round": 3, "unknown_person": 1 },
    "allTime": 34,
    "undated": 0
  }
}
```

### 5.3 Non-negotiable rules for this endpoint

**Blank is never zero.** `"value": null` means *not measured* — no file covers it, or the stage has no source. `"value": 0` means *measured, and the answer was nothing happened*. Ground Up must be able to tell those apart, and must render `null` as `—`, never as `0`. If the builder collapses these, every downstream ratio and projection in Ground Up becomes wrong in a way nobody notices.

**Read through the existing filtered read path.** Ground Truth has exactly one function for filtered reads: `fo_cut(p_view, p_client, p_product, p_channel, p_from, p_to, p_offer)`. This endpoint must call it. Do not write a fresh query that adds numbers up a second, slightly different way — the app already has a live example of two views disagreeing (the Ads tab counts 37 attendees where the By-round tab counts 40, because they dedupe differently), and a third counting path would make that worse.

**Do not recount in application code.** Counting happens in SQL views. The route's job is to call `fo_cut`, shape the JSON, and return it. Any `.filter().length` in the route handler is a bug waiting to drift from the UI's number.

**The date window filters by round overlap, not by event timestamp.** See `supabase/migrations/0023_filters.sql`. A round that starts in July and ends in August is *in* an August window. Ground Up must not assume the response is a clean per-day slice.

**Ship the `coverage` block, and make `lastObservationDate` the EARLIEST source, not the latest.** A number with no statement of how far the data reaches is a number Ground Up will over-trust — and the max across sources is worse than no number at all. Live example: shely's ads reach `2026-05-31` while attendance and sales stop on `2026-05-28` and leads on `2026-05-27`. Reporting `05-31` invites Ground Up to compute a close rate whose numerator is missing four days. Report where coverage runs out. A source with no `coverage_end` makes the whole answer `null`, and the per-source `sources` array is what says which file is the short one — a single date cannot.

**Ship the `parked` block, and window it like everything else.** Rows that failed identity matching are held, not dropped, and are therefore missing from the counts. Ground Up needs to know the counts are provisional. Do not merge parked rows into the values to make the totals look complete.

`count` and `reasons` cover the **same window** as the stage values — a caveat about May attached to an August report is not a caveat, it's noise. `unmatched_rows` carries no observation date of its own (only `parked_at`, which is the clock), so a row is placed by the coverage span of the **import batch it arrived in**, using the same overlap test as the round filter. That is coarser than the stage numbers; say so rather than implying row-level precision.

`allTime` is every waiting row for the client regardless of window. `undated` is the rows no window can place at all — a batch with no coverage dates, or no batch — counted separately so they cannot disappear from both `count` and the caller's attention.

---

## 6. What the Ground Up side needs

Symmetric, and the builder should write both halves so the contract can't drift:

| Endpoint | Direction | Purpose |
|---|---|---|
| `POST /api/integration/funnel-schema` (Ground Truth) | Up → Truth | receive the funnel definition |
| `GET /api/integration/actuals` (Ground Truth) | Truth → Up | serve measured values |
| a client-side caller in Ground Up | Up → Truth | fires the schema push on plan save; calls actuals when rendering plan-vs-actual |

Also on the Ground Up side:

- Store `funnelOsClientId` against each client, so Ground Up knows which `clientId` to name in the push. The two apps do not currently share an ID space — resolve that before writing any code, or the first push will land on the wrong client or on none.
- Retry the push on failure with backoff, and surface a visible "not synced" state in the Ground Up UI. A silent failed push means the two apps disagree about what the funnel is and nobody finds out until a report looks wrong. **Retry `5xx`. Do not retry `400`, `404` or `409`** — those are answers, not outages, and resending the identical body will get the identical reply forever.
- **Never cache a failure.** A failed sync must be retried on the next attempt, not remembered as a bad result. Ground Truth has been bitten by this before: one blocked second became one blocked hour.

---

## 7. Explicit non-goals

Do **not** build these:

- **A mapping editor UI in Ground Truth.** Ground Up owns funnel definition, including the screen where a human picks sources. Ground Truth receives the result. Building an editor on both sides creates two sources of truth for the same fact.
- **Any setup or admin screen in Ground Truth.** Same reason — that surface belongs to the parent system.
- **Client creation without asking for it.** A push *can* open a new client, but only when it sends `createClient: true`. An unknown `clientId` on an ordinary push is overwhelmingly a typo, and inventing a client from it would leave a second near-identical account in the switcher that no import will ever fill.
- **A counting function in TypeScript** (`countStage`-style, per the AcqOS mapping doc). Ground Truth counts in SQL. A TS counter would produce a second set of numbers that disagrees with the screen.
- **A "meaningful value" helper that treats `0` as absent.** It violates the blank-is-never-zero rule directly.
- **A number coercion that turns a parse failure into `0`.** A field that failed to parse is unknown, not zero. Return `null` or reject.
- **A metric fallback** (e.g. substituting all-clicks when outbound-clicks is unavailable). If the requested metric isn't there, the answer is `null`. Substituting a different, larger number that means something else is how a report ends up confidently wrong.
- **Login in Ground Truth.** Shared-key auth on the routes only.
- **Fuzzy name matching**, anywhere, for any reason. Identity is email exact → phone exact → plus-stripped alias → last-8-digits, and nothing else (`lib/import/identity.ts`). This API does not get an exemption.

---

## 8. Sequencing

This work is **blocked**, and building it out of order wastes the effort:

1. **Merge AcqOS `fix/intern-bugs` → main and verify live.** As of writing, that branch has ~10 unpushed commits and a dirty tree. Until it is merged and deployed there is no sender, so the receiving end in Ground Truth cannot be tested against anything real — it would be built against a guessed payload shape and rebuilt when the real one arrives.
2. **Agree the client ID mapping between the two apps.** Cheap, and everything else depends on it.
3. **Build Direction A** (schema push) and confirm one real client's funnel arrives intact.
4. **Build Direction B** (actuals pull) once there is a schema to report against.
5. **Then** native Meta / Google / CRM reads, which is what makes `sourceType` do real work.

Steps 3–5 all sit behind step 1. Step 1 is the critical path.

---

## 9. Files a builder should read first

**Ground Truth (`funnel-os`):**

| File | Why |
|---|---|
| `supabase/migrations/0001_schema.sql` | `client_journey_config` and the seven core tables |
| `supabase/migrations/0002_seed.sql` | the real journey rows for Shely — what a valid stage set looks like |
| `supabase/migrations/0031_the_journey_strip_respects_the_filter.sql` | the authoritative `stage_metric` whitelist |
| `supabase/migrations/0023_filters.sql` | round-overlap period filtering |
| `lib/funnel/spine.ts` | the `MetricKey` union; `fmt()` and its null handling |
| `lib/funnel/data.ts` | how the app reads through `fo_cut` |
| `lib/import/identity.ts` | identity rules and the seven park reasons |

**House rules that apply to any change here:**

- `create or replace view` may only **append** columns. Reordering or removing one breaks the replace.
- Migrations are run by hand in the Supabase SQL editor. Do not apply them programmatically; deliver the SQL file.
- Blank is never zero, anywhere in the app.
