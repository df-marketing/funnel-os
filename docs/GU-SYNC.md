# Sharing logins and onboarding with GroundUp

**Asked for:** onboard a client once, not twice, and have one login work in both systems.

**Short version:** the onboarding half is already built and has been for a while. The login half
cannot be designed until one question is answered, and it is not a technical question.

---

## What already exists

GroundTruth already has a wire to AcqOS, authenticated by `INTEGRATION_SHARED_KEY` with a
timing-safe compare. It runs in both directions:

```
AcqOS → GT     POST /api/integration/funnel-schema     the journey, and the client itself
GT → AcqOS     GET  /api/integration/actuals           what actually happened
               GET  /api/integration/series
               GET/POST month-insight, round-insight
```

**`funnel-schema` already creates clients.** The payload carries `clientId`, `clientName`,
`clientNote`, `currency`, the journey `stages`, and a `createClient` flag. Sending it with
`createClient: true` writes `client_journey_config` and `client_flags` and the client exists in GT —
switcher, journey strip, tabs and all. Sending it again for a client that exists is deliberately not
an error, so a retried push is safe.

So *"create the client in GU, then go and create it again in GT"* is already avoidable. If somebody
is doing it by hand today, the wire is there and is not being called.

**Worth checking before building anything: is AcqOS actually calling this on client creation?** If
it is, half the request is done. If it is not, wiring that call is a smaller job than anything else
in this document.

---

## The question that decides the rest

The supervisor has said clients get **no access to GroundUp or GroundWork** — GroundTruth is the only
system they ever open.

If that holds, then **clients have no GU login to share.** "One login" would apply only to
DriveFunnels staff, who are a handful of people, and the work is worth far less than it sounds.

So, before design:

> **Do client users exist in GU at all — or is GU staff-only?**

- **GU is staff-only** — then this is about DriveFunnels staff not keeping two passwords. Real, small,
  and probably not worth a large piece of work. The client-facing accounts stay in GT, provisioned by
  GT, and only the client *record* syncs.
- **Clients do have GU accounts** — then the supervisor's "no GU access" means no GU *screens*, not no
  GU *account*, and shared identity is worth building properly.

Everything below assumes the second. Under the first, stop after "what already exists" and just make
sure AcqOS calls `funnel-schema` on creation.

---

## Three ways to share identity

### A · GT verifies tokens GU issues

GU stays the only place a person signs in. It hands out a token; GT verifies the signature and reads
the user out of it. No shared database, no second password, and GT keeps its own record of which
clients a user may read.

If GU is on Supabase, this is verifying a JWT against GU's project — GT already speaks that format,
and the change is in `lib/auth/access.ts` and the middleware, which is where identity is decided
today.

**Best fit if GU already has the users.** The risk is that a token issued for GU is now also a key to
GT, so its lifetime and revocation become GT's problem too.

### B · GU pushes users and grants over the wire that already works

A new endpoint beside `funnel-schema` — `POST /api/integration/access` — carrying "these people may
read this client". GT provisions the accounts and the grants.

**Smallest change, and it reuses a wire already proven in production.** Onboarding becomes one
action in GU. Its weakness is that it does not give one *password* — it gives one *place to decide
access*, with GT still holding its own credentials. That may be enough; it depends on whether the
complaint is "two admin steps" or "two passwords".

### C · Both systems use one identity provider

Supabase Auth shared between them, or something like Clerk or WorkOS in front of both.

**The right long-term answer if GroundTruth is going to be the centre of information for all
clients.** Also the largest change, touches both codebases, and should not be the first thing tried.

---

## What I need from GroundUp

Small list, and every item changes the answer.

**1 · The auth stack.** Supabase Auth, NextAuth, Clerk, or something custom? If Supabase — the same
project as GT, or a different one? *Decides whether A is a day or a fortnight.*

**2 · Do client users exist in GU today?** The question above. *Decides whether this is worth doing
at all.*

**3 · How a client is created in GU.** The table or model, and the identifier it uses. GT's clients
are `shely`, `northsea_supply`, `acme_fitness` — lowercase, letters, numbers, underscores. *If GU
uses a uuid or a display name, something has to map between them, and that mapping is where the two
systems drift apart.*

**4 · Whether GU already maps users to clients.** If it does, B is mostly a serialisation job. If it
does not, GT's `client_users` is the only such mapping and GU would be reading it rather than
writing it.

**5 · Whether AcqOS currently calls `funnel-schema` on client creation.** *If yes, half the request
is already done and nobody noticed.*

**From the codebase, if it is easy:** the auth middleware or session helper, and the client-creation
path. Two files would answer 1, 3 and 5 between them. A handover document naming the auth provider
and the client model would do just as well — this does not need a repository.

---

## What I would recommend once those are answered

Likely shape, stated now so it can be argued with rather than discovered later:

1. **Confirm AcqOS calls `funnel-schema` with `createClient: true`.** Possibly the whole of the
   onboarding half, for the cost of a phone call.
2. **Then B**, because it reuses a proven wire and makes GU the single place access is decided.
3. **A or C later**, if "one password" turns out to be the actual complaint rather than "two admin
   steps".

And one ordering constraint that is not negotiable: **none of this before the database upgrade.**
Shared identity means more simultaneous users, and the instance already throttles under two people
clicking at once — see `PERFORMANCE.md`.
