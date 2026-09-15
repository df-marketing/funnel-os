# The slug is not an identity — GroundTruth's half

**Status: ON HOLD, 15 September 2026. Nothing in this document has been shipped.**
No migration has been run, no column added, no route changed.

> **§7's first question came back NO.** AcqOS has no stable per-stage identity to send.
> `stage_index` breaks on reorder; `stage_key` is `slugify(label)` and breaks on rename. So §5.1 —
> "AcqOS sends a stable identity" — rests on a field that does not exist.
>
> **That turns this from a payload change into a scope decision: somebody has to mint an identity
> that has never existed.** The contract below is still correct about *what* is needed and *why*;
> it is wrong only in assuming the identity was already there to be sent.
>
> **Two things this changes, both in §8.**

**The bug is unfixed and still live.** Holding is a decision about cost, not about risk — §3 happens
on the next funnel edit that moves a stage, and it will not announce itself.

**Read off the code on 15 September 2026.** Every claim below cites a file and line, or is marked
as unverified.

---

## 1 · What AcqOS told us, and what we confirmed independently

AcqOS says it assigns `stage_slug` **by position, not identity**, so a routine funnel edit moves
them. We did not take that on trust. Production agrees:

| position | shely | acme_fitness | zenith_saas | northsea_supply |
|---|---|---|---|---|
| 1 | `targeting` | `targeting` | `targeting` | `targeting` |
| 2 | `ads` | `ads` | `ads` | `ads` |
| 3 | `lp` | `lp` | `lp` | `product` |
| 4 | `class` | `class` | `appointment` | `appointment` |
| 5 | `preview` | `preview` | `preview` | `checkout` |
| 6 | `middle` | — | — | — |

Four clients, four different funnels, and positions 1 and 2 are identical in all of them. The slugs
are drawn from a small fixed vocabulary of *roles*, assigned in order. That is consistent with
AcqOS's account and inconsistent with the slug being a name the stage owns.

---

## 2 · The bug is worse than preservation, because the slug does three jobs

This is the part AcqOS cannot see from their side, and it is the reason GroundTruth's half is not
simply "add a column".

**Job 1 — the preservation key.** `0040_a_push_keeps_the_breakdown_and_the_label.sql:84-94` reads
three slug-keyed maps *before* deleting the client's stages at `:112`, then re-applies them in the
insert by `v_prices->>(stage->>'slug')`, `v_dims->>(stage->>'slug')`, `v_rates->>(stage->>'slug')`.

**Job 2 — the URL.** `components/Shell.tsx:224-225` builds every tab's href from `s.stage_slug` and
compares `view === s.stage_slug`; `app/page.tsx:250` resolves the open tab with
`data.stages.find((s) => s.stage_slug === view)`; `lib/funnel/data.ts:892` builds the set of valid
views from the slugs.

**Job 3 — which metric view the tab reads.** `lib/funnel/cuts.ts` selects the cut by matching the
slug against hardcoded string sets:

```
:25  const NEEDS_ADSETS  = new Set(["targeting"]);
:29  const NEEDS_ADS     = new Set(["ads"]);
:30  const NEEDS_VARIANT = new Set(["class"]);
:31  const NEEDS_LANDING = new Set(["lp"]);
:32  export const NEEDS_OFFER = new Set(["preview", "middle"]);
```

So a slug is simultaneously a database key, a public URL, and a `switch` statement. AcqOS moving one
does three different kinds of damage at once, and only the first is about money.

---

## 3 · The failure, with real numbers

shely's stage 5 is `preview` — "Paid Workshop Purchase ($297)" — and it is the row that holds
`unit_price = 297`. Stage 4 is `class`, "Live Webinar Attendance", which holds no price.

Insert one stage into shely's funnel above position 4 and re-slug by position:

1. `v_prices` is read as `{"preview": 297, ...}` before the delete — `0040:84-94`.
2. The rows are deleted — `0040:112`.
3. The incoming stage now carrying the slug `preview` is **the attendance stage**, and the insert
   hands it `297` because it matched on the slug.
4. The real purchase stage now carries a different slug, finds nothing in `v_prices`, and comes back
   with `unit_price = null`.

**Revenue moves from the purchase stage to the attendance stage. Both pushes return `written: true`.
Nothing throws, nothing logs, and the response's `pricesPreserved` count is unchanged** — it counts
how many prices were re-applied, not whether they landed on the right stage.

Separately, jobs 2 and 3 fail quietly in their own way: a slug that has moved out of
`NEEDS_OFFER` still renders a tab, because the tab comes from the database, but `cuts.ts` no longer
recognises it and the tab reads the wrong view. A slug that changes at all invalidates every
bookmarked URL.

### Reproduced, 15 September 2026 — this is no longer inference

This section originally said the mechanism was read off the SQL and not observed. It has since been
run. `scripts/test-slugmoved.mts` pushes shely's exact funnel to a **throwaway client**, then pushes
it again with one stage inserted above position 4, and asserts the outcome in the table rather than
in the response:

```
ok   preview was the purchase stage       — "Paid Workshop Purchase ($297)"
ok   preview is now the attendance stage  — "Live Webinar Attendance"
ok   the attendance stage really did take the 297
ok   and the purchase stage really did lose it
ok   the push still reports success
ok   and pricesPreserved still says preview — which is exactly the problem
```

15 assertions, all passing, against the live function. The client is deleted afterwards and shely is
never touched — verified after the run: shely still has six stages with `preview` holding 297.

**The last two lines are the finding.** `written: true` and `pricesPreserved: ["preview"]` are both
returned, and both are true statements about a push that just moved $297 from the purchase stage to
the attendance stage. Nothing in the pre-existing response distinguishes this from a correct push.
That is why §8.2's alarm exists and why an empty `slugsMoved` still is not a guarantee.

---

## 4 · What is already safe, so nobody over-fixes it

- **Within a single payload, slugs are unique.** `lib/integration/schema.ts:224-226` rejects
  duplicates with `duplicate slug '<slug>' — each stage needs its own`. The exposure is slug
  *movement between pushes*, not collision inside one.
- **A stale push cannot clobber a fresh one.** `0040` compares `generatedAt` against the stored
  value and returns `{written: false, reason: "stale_push"}` if it is older.
- **The database does not enforce slug uniqueness at all.** `client_journey_config`'s primary key is
  `(client_id, stage_order)` — `0001_schema.sql:163-183`. `stage_slug` is an ordinary nullable
  column. The validator is the only thing keeping slugs distinct, and it only sees one payload.

---

## 5 · The proposal

### 5.1 AcqOS sends a stable identity

One new required field per stage, `stageId`: whatever AcqOS's own stage row is keyed on, as long as
it survives reordering, renaming, and insertion. A UUID is ideal. It must **never** be derived from
the stage's position, name, or role.

### 5.2 GroundTruth keys preservation on it

Add `stage_ref text` to `client_journey_config` and a unique index on `(client_id, stage_ref)` where
`stage_ref is not null` — the constraint the slug never had. `0040` then builds its three maps keyed
on `stage_ref` instead of `stage_slug`.

### 5.3 The migration path for rows that only have slugs

Every existing row has no `stage_ref` — all four clients, confirmed. So there has to be exactly one
push where the binding is made, and it is the dangerous one:

> **The adoption push must be a no-op push.** Same funnel, no stages added, removed, renamed or
> reordered. GroundTruth matches incoming `stageId` to existing rows **by slug, once**, writes
> `stage_ref`, and from then on never consults the slug for preservation again.

If the adoption push is also the push that moves a stage, the binding is made against already-moved
slugs and the wrong values are preserved permanently — the one-time fallback inherits the exact bug
it exists to end. This is the sentence in this document most worth arguing about.

Two guards we propose to make that safer, both on GroundTruth's side:

- **Refuse to adopt and edit in the same push.** If any row for this client lacks `stage_ref` *and*
  the incoming stage set differs from what is stored (by slug, count or order), refuse with a new
  code — `adoption_must_be_noop` — rather than guess. Sequencing beats cleverness here.
- **Report what bound to what.** The response gains `adopted: [{stageId, slug, order}]` so the
  binding is visible in AcqOS's logs on the day it happens, not inferred months later.

### 5.4 What GroundTruth still owes, and is not proposing here

Jobs 2 and 3 are ours alone. Even with `stage_ref`, a slug that changes still breaks the URL and
still falls out of `cuts.ts`'s hardcoded sets. The fix is for `cuts.ts` to select on `stage_metric`
and `source_type` — columns that already exist — rather than on the slug string, and for the router
to treat the slug as a display alias.

**That is a separate change and is deliberately not in this proposal.** It is GroundTruth-internal,
it touches every tab, and bundling it with a cross-system contract change would make both harder to
review. Flagging it so AcqOS knows that until it is done, **GroundTruth needs slugs to stay stable
for a given `stageId`** even once identity is fixed.

---

## 6 · The payload contract

Exact, so the two halves can be diffed.

### 6.1 Request — `POST /api/integration/funnel-schema`

Unchanged except for `stageId` on each stage. Every other field is as
`lib/integration/schema.ts:41-51` validates it today.

```jsonc
{
  "source": "acqos",                    // must be exactly this
  "schemaVersion": 1,                   // integer, currently 1
  "generatedAt": "2026-09-15T09:00:00Z",// ISO 8601; older than stored → stale_push
  "clientId": "shely",                  // ^[a-z0-9_-]+$
  "clientName": "Memi AI",
  "currency": "USD",                    // 3-letter ISO, or RM
  "createClient": false,
  "clientNote": null,
  "stages": [
    {
      "stageId": "8f3c1e02-5b7a-4d19-9c44-2ab6e0f7d531",  // NEW — required, stable, opaque
      "order": 1,                        // positive integer, unique in payload
      "slug": "targeting",               // ^[a-z0-9-]+$, unique in payload
      "name": "Ad Impressions",
      "metric": "impressions",           // one of JOURNEY_METRIC_KEYS
      "sourceType": "meta",              // meta | google | crm | csv
      "sourceRef": "ads_performance.impressions",
      "compareDimension": "ads_performance.ad_set",  // null, or table.column
      "rateLabel": "impressions",        // null allowed
      "unitPrice": null                  // null, or a non-negative number
    }
  ]
}
```

**`stageId` rules, stated so neither side assumes:**

| | |
|---|---|
| required | yes, on every stage, from the first push that carries any |
| shape | opaque string, 1–128 chars. GroundTruth will not parse it |
| stable across | reordering, renaming, slug changes, metric changes, adding/removing other stages |
| unique within | one payload, and one client, forever |
| must not encode | position, order, name, role, or anything a user can edit |
| reused after delete | **no.** A deleted stage's id must never be given to a new stage |

### 6.2 Response

Existing fields keep their meaning. Added:

```jsonc
{
  "written": true,
  "pricesPreserved": 1,
  "dimensionsPreserved": 4,
  "rateLabelsPreserved": 5,
  "keyedOn": "stage_ref",               // NEW — "stage_ref" | "stage_slug"
  "adopted": [                          // NEW — non-empty only on the binding push
    { "stageId": "8f3c1e02-…", "slug": "preview", "order": 5 }
  ]
}
```

`keyedOn` is the field that makes this testable from AcqOS's side: while it reads `stage_slug`, the
old behaviour is still in force and the bug is still live.

### 6.3 New refusal

Joins the contract at `lib/integration/codes.ts`, so it arrives with a `recover` value like the
other four.

| code | status | recover | means |
|---|---|---|---|
| `adoption_must_be_noop` | 409 | `resend-unchanged` | this client's stages have no `stage_ref` yet, and this push also changes the funnel. Push the funnel unchanged once to bind identities, then push the edit. |

---

## 7 · What we need from AcqOS

1. **Confirm `stageId` exists on your side and is genuinely stable** — specifically, that it survives
   a user reordering stages in the Growth Journey editor. If it does not exist yet, that is the real
   first task and this contract is blocked on it.
2. **Confirm the no-op adoption push is possible** — that you can push an unchanged funnel for each
   existing client before any edit lands. Four clients today: `shely`, `acme_fitness`,
   `zenith_saas`, `northsea_supply`.
3. **Tell us if you would rather refuse or repair** when adoption and edit collide. We propose
   refuse; you carry the user-facing consequence of that, so it is your call.
4. **A shifted push at a throwaway handle**, so the failure in section 3 is observed rather than
   reasoned about.

Nothing is built on our side pending answers to 1 and 2.

---

## 8 · After AcqOS's answer — two inputs to the scope decision

Neither is a request to build. Both change what the decision is choosing between.

### 8.1 · Who mints the identity is an open question, and GroundTruth may be the cheaper answer

§5.1 assumed AcqOS mints it because AcqOS owns the funnel. That was an assumption, not a
requirement, and it is the expensive reading: it asks AcqOS to add an identity to a model that has
never had one, and to keep it stable through every edit path a user can reach.

**The inverse costs less, and there is precedent for it in this integration.** GroundTruth already
mints a permanent identity that AcqOS stores and echoes back — the handle. `client_flags.client_id`
is reserved by GT, held forever, and AcqOS carries it on every subsequent call. A stage ref is the
same shape of thing one level down.

```
 push 1   AcqOS sends stages with no refs
          GT mints one per stage, stores it, returns  stageRefs: { "preview": "st_7f3a…" }
 push 2+  AcqOS echoes each stage's ref back
          GT keys preservation on the ref; the slug is decoration
```

What each side actually has to do:

| | AcqOS | GroundTruth |
|---|---|---|
| mint a stable id | **no** | yes — one `gen_random_uuid()` at insert |
| keep it stable across edits | **no** — GT holds it | yes, by not deleting the row |
| store one opaque string per stage | yes, one column | yes, `stage_ref` |
| echo it on the next push | yes | — |

AcqOS's side becomes *store this string and send it back*, which is a column and a passthrough, not
an identity model. **The first push still has to be a no-op push** — §5.3's constraint survives
unchanged, because minting still has to bind to existing rows by slug exactly once.

**What this does not solve.** A stage created in AcqOS between two pushes arrives with no ref and
gets a fresh one, which is correct. A stage *deleted* and an unrelated one *created* in the same
edit are indistinguishable from a rename — GT sees one ref vanish and one appear. That is a real
limit of minting from the outside and it does not exist if AcqOS mints. It is the trade the scope
decision is actually between.

### 8.2 · Detection needs no identity at all, and is nearly free

While the fix is on hold, the failure can at least stop being silent. `0040` already computes the
at-risk set before the delete:

```sql
-- Which incoming stages will be taking a value they did not send.
select ... into v_kept from jsonb_array_elements(p_stages) as stage
 where nullif(stage->>'unitPrice','') is null and v_prices ? (stage->>'slug');
```

Every slug in `v_kept` is about to inherit a price from whatever held that slug last time. The
prior `stage_name` for each is one column away, in a table the function has already read and not
yet deleted. Comparing it to the incoming `name` answers the dangerous question directly:

> **the slug stayed, but the stage under it changed.**

Returned as `slugsMoved[]`, that is additive — a new response field, no refusal, no behaviour
change, one-sided and safe to ship without AcqOS.

**Its limits, stated rather than discovered later.** It compares names, so a stage genuinely renamed
in place reports a false positive, and a reorder that happens to keep names aligned with slugs
reports nothing. It is a smoke alarm, not a lock. It does not make a push safe; it makes a bad push
**visible on the day it happens** instead of whenever somebody next questions a revenue line.

**Built and applied 15 September 2026.** The migration is
`20260915120000_a_push_says_when_a_slug_changed_hands.sql`; the response carries `slugsMoved[]`
and a `slugWarning` sentence. `npm run test:slugmoved` — 15 assertions — proves it fires on the
§3 case and, deliberately, that it false-positives on a rename in place.

It changes nothing about the risk. The wrong value is still written; it is now **announced**.
