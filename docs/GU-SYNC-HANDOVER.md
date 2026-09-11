# AcqOS → GroundTruth — what to call, and how to prove it worked

**For:** the session working on AcqOS / GroundUp.
**From:** GroundTruth (Funnel OS). Contract read off the live routes on 11 September 2026.

GroundTruth's side is built and deployed. It has never been called by AcqOS, so nothing about this
is proven end to end yet. This is everything you need to make the call and everything we will check
afterwards.

**Base URL:** `https://funnel-os-red.vercel.app`

---

## 0 · The one blocker, and it needs both of us

Every route below authenticates on a shared secret in the header `x-integration-key`. GroundTruth
production **has** a value — it answers `401 unauthorized` rather than `503`, which is how it says
"configured, but that is not it".

**We cannot read it back.** It is marked Sensitive in Vercel, and our local copy does not match it —
verified: production rejects the key in our `.env.local`.

**So generate a new one and set it in three places:**

```
1. GroundTruth  →  Vercel → funnel-os → Environment Variables
                   INTEGRATION_SHARED_KEY   (Production AND Preview), then redeploy
2. GroundTruth  →  the dev machine's .env.local
3. AcqOS        →  wherever you keep it, plus FUNNEL_OS_BASE_URL
```

⚠️ **Until that is one value, every call below returns 401 and proves nothing.** It is not a code
change on either side.

**AcqOS also needs `FUNNEL_OS_BASE_URL = https://funnel-os-red.vercel.app`.** We understand that is
not set yet.

---

## 1 · The three calls, in order

All three take `POST` and the header `x-integration-key: <shared secret>`.

### 1.1 Reserve the handle

```
POST /api/integration/client-handle
{ "clientId": "acme_fitness", "sourceClientId": "<AcqOS clients.id uuid>" }
```

| Field | Rule |
|---|---|
| `clientId` | `^[a-z0-9_-]+$` — lowercase letters, digits, `_`, `-`. **This is the handle GroundTruth will know the client by forever.** |
| `sourceClientId` | **Required**, and must be the AcqOS `clients.id` **UUID**. Not optional — a claim without it is a handle held by nobody in particular, which is the thing this endpoint exists to prevent. |

**Responses**

| Code | Body | Meaning |
|---|---|---|
| `201` | `{ ok, clientId, claimed: true, adopted, note }` | Reserved. `adopted: true` means a handle that already existed by hand — e.g. `shely` — was adopted rather than duplicated. |
| `200` | `{ ok, clientId, claimed: false, alreadyYours: true }` | **You already hold it. This is a successful retry, not an error.** |
| `409` | `{ ok: false, code: "handle_taken", error, retry }` | A **different** AcqOS client holds it. Mint a different handle. |
| `409` | `{ ok: false, code: "source_holds_other", error, heldHandle, retry }` | **This** AcqOS client already holds a different handle. Use `heldHandle`; do not mint another. |
| `400` | `{ ok: false, error }` | Shape violation — bad `clientId` pattern, or `sourceClientId` not a uuid. |
| `401` | `{ ok: false, error: "unauthorized" }` | Wrong shared key. |
| `503` | `{ ok: false, error }` | GroundTruth has no key or no service-role key configured. Ours, not yours. |

> ⚠️ **Branch on `code`, never on the status.** Two different 409s want opposite things:
> `handle_taken` means *try another handle*; `source_holds_other` means *stop and use the one you
> have*. Treating them the same either loops forever or hands one client's reporting to another.

### 1.2 Push the funnel — this is what makes the client visible

```
POST /api/integration/funnel-schema
```

A `201` from step 1.1 says: *"handle reserved. The client is not visible until a funnel is pushed."*
That is literal. A claimed handle with no funnel has no journey, so it does not appear in the client
switcher and has nothing to report.

**If you want a screenshot of the client existing in GroundTruth, you must call this.** The payload
is the stage list and metrics; it validates and returns `400` with a per-field `errors[]` array
naming the stage and field, so a rejection tells you which stage is wrong rather than that something
is.

### 1.3 Admit the person

```
POST /api/integration/client-user
{ "email": "someone@client.com", "clientId": "acme_fitness", "sourceClientId": "<same uuid>" }
```

**Responses**

| Code | Body | Meaning |
|---|---|---|
| `201` | `{ ok, clientId, email, created: true, signInLink, linkError, note }` | Account created, grant written, link returned. |
| `200` | same, `created: false` | Already existed. **Safe to call twice** — a retry still returns a usable link. |
| `404` | `{ ok: false, code: "handle_not_claimed", error, hint }` | No such handle here. Claim it first. |
| `409` | `{ ok: false, code: "handle_mismatch", error, retry }` | That handle belongs to a different AcqOS client. |

**What GroundTruth does, and why:**

- **Creates the auth user with no password.** AcqOS hashes passwords at signup and never holds the
  plaintext, so there is nothing to copy — and two systems holding the same password drift the first
  time anyone changes one, with nothing to detect the drift.
- **Returns `signInLink` rather than sending mail.** AcqOS already has the address and a welcome
  template; one email from a system the client has heard of beats two.
- **`signInLink` may be `null` with `linkError` set.** The grant is still written and correct — a
  link can be reissued, and losing the access over an undeliverable link would be the wrong trade.
  Treat a null link as *retry the link*, not *retry the onboarding*.

**`DELETE`** with `{ email, clientId }` revokes the grant. **The auth user survives on purpose:**
AcqOS owns whether the person exists; GroundTruth owns what they may read.

---

## 2 · The test we would like you to run

Use a throwaway handle so nothing needs cleaning off a real client.

```
handle           gu_live_test
sourceClientId   any real AcqOS clients.id uuid from a test account
email            something you control
```

1. `client-handle` with that pair → expect **201**, `claimed: true`
2. **The same call again** → expect **200**, `alreadyYours: true`
3. `client-handle` with the **same handle** and a **different** `sourceClientId` → expect **409
   `handle_taken`**
4. `client-user` → expect **201**, `created: true`, a `signInLink`
5. `client-user` again → expect **200**, `created: false`
6. `client-user` **DELETE** → expect `{ revoked: true }`

**Send us the six status codes and bodies.** That is the proof, and it is the same sequence we ran
against a local server — we want it from AcqOS, over the wire, against production.

---

## 3 · What we check at our end

Once you have run it, tell us and we will confirm from GroundTruth's database:

- `client_flags` holds `gu_live_test` with **your** `sourceClientId` and a `claimed_at`
- an auth user exists for the email, **with no password set**
- `client_users` holds the grant
- the sign-in link resolves to a working session

Then we remove all of it. **Nothing from a test stays.**

---

## 4 · Things worth knowing before you build against this

**The handle is permanent.** It becomes `client_id` on every row GroundTruth ever stores for that
client. Mint it from something stable, not from a display name somebody may rename.

**Claiming is not a schema push.** A claim writes `source_client_id` and `claimed_at` and leaves the
client's name and currency alone. Adopting an existing handle does not overwrite what is there.

**There is no button on our side, deliberately.** The routes are live and nothing in GroundTruth's
UI calls them. Nothing becomes client-facing until someone adds one, and that is a decision waiting
on a person rather than an oversight.

**One login per client, for now.** That is what AcqOS can express — `clients.portal_user_id` is a
single column. Nothing here forbids a second person; `client_users` is a join table and will take
another row the day AcqOS can name one.

---

## 5 · What we need from you

1. **The shared key**, generated once and set in both systems *(section 0)*
2. **`FUNNEL_OS_BASE_URL`** set on AcqOS
3. **The six responses** from section 2
4. Confirmation that you branch on **`code`** and not on the HTTP status for the two 409s

Nothing else is outstanding on GroundTruth's side.
