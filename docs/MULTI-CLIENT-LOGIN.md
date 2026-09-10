# Per-client logins — a plan

**Asked for:** each client gets their own login and sees only their own data, because GroundTruth is
becoming the centre of information for every client.

**Status today:** there is no login, and that was deliberate. Anyone with the URL can read any
client by changing one query parameter. This is the plan to change that.

**Read this before writing any code.** There are two traps in it, and both fail silently — the app
looks completely correct while showing one client another client's revenue.

---

## Where the app actually is

Measured, not assumed:

```
17  tables holding client data
57  views in the read path
30  functions
30  row-level-security policies — every one of them `using (true)`
 1  view that sets security_invoker (and it is a comment saying it is OFF)
 1  SECURITY DEFINER function (fo_refresh_lookups, added for the lookup cache)
```

The read client uses the **anon key with `persistSession: false`** — no user identity is ever
attached to a read, because there is no user. The client is chosen by `?client=` in the URL and
passed to `fo_cut` as a parameter.

Proof of the current model, run just now with nothing but the public key:

```bash
curl "$URL/rest/v1/rpc/fo_cut" -H "apikey: $ANON" \
  -d '{"p_view":"v_metrics_total","p_client":"northsea_supply"}'
# → returns Northsea's figures
```

That is not a bug today. It becomes one the moment a client is given a login.

---

## Decision one, before any code: where does identity live?

**Funnel OS is a subset of AcqOS.** Setup and admin belong to the parent system.

So: **do clients already log in to AcqOS?**

- **If yes** — Funnel OS should accept that identity, not mint its own. Two user lists is two things
  to keep in sync, and the day they disagree somebody sees the wrong client's revenue. The work
  becomes "trust an AcqOS-issued token and map it to a client", which is smaller and safer.
- **If no** — Supabase Auth here, with the expectation that AcqOS will later want the same users.
  Build the user↔client mapping as its own table from day one so it can move.

**This is a question for the supervisor, not a technical detail.** It changes the shape of
everything below. Nothing else should start until it is answered.

---

## Trap one: RLS policies alone do nothing here

A Postgres view runs with its **owner's** rights unless it is explicitly created with
`security_invoker = on`. Row-level security on the underlying tables is not re-evaluated.

The codebase already knows this. From `0003_views.sql`:

> *Views run with the owner's rights (security_invoker is off by default), so base-table RLS isn't
> re-evaluated per row here; read access is what's granted.*

So the obvious implementation — add a `client_users` table, write policies keyed on `auth.uid()`,
ship it — produces an app where **every client still sees every other client's data**, with no
error, no warning, and correct-looking screens.

`security_invoker = on` has to go on **all 57 views**, and the ones that read other views need it
too or the chain breaks at the first one that lacks it.

---

## Trap two: the cache does not know who is asking

Every read is wrapped in `unstable_cache` and held for thirty minutes. The cache key is built from
the function arguments, and today those arguments include `client_id` — so the cache is already
segmented per client, and that is the only reason it is safe.

**If the filter moves from "the client_id argument" to "whatever `auth.uid()` is allowed to see",
the cache stops being segmented and starts serving one client's cached page to another.**

The rule that avoids it:

> **Authorise before the cache. Filter by explicit client_id inside it.**
>
> The page checks "is this user allowed client X" on every request, uncached. Only then does it read
> the cached data for client X, keyed by X exactly as it is now. RLS is the backstop underneath, not
> the thing doing the filtering.

Getting this backwards is the difference between a cache and a data breach, and it will not show up
in testing with one user.

---

## What to build, in order

### 1 · The mapping table

```sql
create table client_users (
  user_id   uuid not null references auth.users (id) on delete cascade,
  client_id text not null,
  role      text not null default 'viewer',   -- viewer | staff
  primary key (user_id, client_id)
);
```

A DriveFunnels staff user gets a row per client, or a `staff` flag that means all. A client user gets
exactly one row.

### 2 · The gate

`middleware.ts` already refreshes the Supabase session on every request and does nothing with it.
It becomes: no session → redirect to `/login`. A login page, and sign-out.

### 3 · Authorisation at the page, uncached

Before `getDashboard` runs, resolve the user's allowed clients and check the requested one against
them. Wrong client → 404, not a redirect to their own. A redirect confirms the client exists.

### 4 · The client switcher shows only what they hold

`loadClients` currently returns everything. It takes the allowed list and filters. A client with one
client sees no switcher at all.

### 5 · RLS underneath, as a backstop

Real policies on the 17 tables, keyed on `client_users`, **and `security_invoker = on` on all 57
views**. This is defence in depth: if step 3 is ever missed on a new page, this is what stops it
being a breach rather than a bug.

Two things must keep bypassing it, deliberately:

- **The service-role client** used by imports. Imports are server-side only and write across clients.
- **The integration routes** (`/api/integration/*`), which are machine-to-machine on
  `INTEGRATION_SHARED_KEY` and have no user.

### 6 · The verification pass — this is where the risk is

Not a smoke test. For a user holding only Shely:

- every one of the 57 views returns **zero rows** for Northsea, read through their session
- `?client=northsea_supply` in the URL returns 404
- the client switcher offers one client
- `fo_cut` with `p_client => 'northsea_supply'` returns nothing
- the same checks with the two clients reversed
- a staff user still sees both

Verify **through the app's session**, never through the SQL editor. The editor connects as a
superuser and sees rows the app cannot; that difference has already produced one false pass on this
schema — zero mismatches in the editor, 44 out of 46 through the app's key.

---

## Estimate

**3–5 days**, and it should not be compressed. Most of it is steps 5 and 6, not the login screen.

Roughly: mapping table and login half a day, authorisation and switcher half a day, RLS and
`security_invoker` across 57 views one to two days, verification one day.

---

## Sequencing against everything else

**Do the database upgrade first.** RLS adds a per-row predicate to every read, and the instance
currently throttles under two users clicking at once — see `PERFORMANCE.md`. Measuring RLS overhead
on a throttled free tier will produce numbers nobody can act on, and the first thing multiple logins
guarantee is multiple simultaneous users.

Order: **size the database → answer the AcqOS identity question → build → verify.**

---

## What this does not cover

- **Per-user permissions inside a client** — everyone who can see Shely sees all of Shely. Finer
  than that is a different piece of work and nobody has asked for it.
- **Audit logging.** Worth adding when clients can log in, and not in this estimate.
- **Import access.** The import tab writes. A client user must not have it, which is a fourth screen
  to gate rather than a new mechanism.
