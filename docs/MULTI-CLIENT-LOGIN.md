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

## Identity lives here — and that answer carries a second change with it

**Clients do not get GroundUp or GroundWork. GroundTruth is the only thing they will ever see.**

So there is no AcqOS identity to reuse. Funnel OS owns its own users, via Supabase Auth. That is the
simpler half of the answer.

The harder half: **this app stops being internal.** It was built for DriveFunnels staff, and it
shows — in three places that a client must not reach, and in copy written for somebody who can open
the SQL editor.

### Three tabs are staff-only, and one of them writes

```
Import      writes to the database. A client must never have it.
Unmatched   the reconciliation queue — raw parked rows, other people's names and money.
AcqOS       the parent system's wiring, which clients are explicitly not being given.
```

`Form answers`, `By month`, `By round`, `Round × source`, `This round` and the stage tabs are all
fine for a client to read. The gate is per tab, not per app.

### The copy assumes a colleague is reading it

Real strings in the app today:

> *"Run `supabase/migrations/ALL.sql` in the Supabase SQL editor — that's the 7-table schema, the
> seed and the metric views, in order."*
>
> *"…which migration `0033` adds."*
>
> *"Use this after changing rows in the SQL editor."*

These are good messages for you and unusable in front of a client: they expose the stack, they read
as an error the client caused, and they name things the client has no access to. Every empty state
and error path needs a second reading with a client in mind — not a rewrite of the app's voice, just
the removal of instructions only staff can act on.

### Branding stops being a non-issue

It was reasonable to say branding did not matter while the only readers were internal. Once a client
logs in to look at their own revenue, the login page and the header are the product. This does not
have to be much — a name, a logo, the client's own name where "DEMO ACCOUNT" currently sits — but it
has to be decided rather than inherited.

**None of this is hard. All of it is invisible until a client is looking at the screen**, which is
why it belongs in the plan rather than in a later cleanup.

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

### 4b · Staff-only tabs, and staff-only language

Gate `import`, `unmatched` and `acqos` on `role = 'staff'` — hidden from the nav and 404 on direct
URL, because hiding a link is not access control.

Then walk every empty state and error path and ask whether a client could reach it. The ones naming
`supabase/migrations`, the SQL editor or a migration number are the known offenders; there will be
others. A client hitting an empty round should read "no data for this round yet", not an instruction
to run a file they cannot open.

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

And one that is not about data: **log in as a client and read every screen as if you were them.**
Every tab reachable, every empty state, every error. It is the only way to find the copy written for
a colleague, and it takes an hour.

---

## Estimate

**4–6 days**, and it should not be compressed. Most of it is steps 5 and 6, not the login screen.

```
mapping table, login, sign-out              0.5 day
authorisation, switcher, staff-only tabs    1   day
RLS + security_invoker across 57 views      1–2 days
client-facing copy pass                     0.5 day
verification, including reading as a client 1   day
```

The copy pass is the one that looks skippable and is not. It is the difference between a client
seeing their revenue and a client seeing an instruction to run a migration.

---

## Sequencing against everything else

**Do the database upgrade first.** RLS adds a per-row predicate to every read, and the instance
currently throttles under two users clicking at once — see `PERFORMANCE.md`. Measuring RLS overhead
on a throttled free tier will produce numbers nobody can act on, and the first thing client logins
guarantee is multiple simultaneous users — which is exactly the condition the free tier fails under.

Order: **size the database → build → verify → then hand out logins.**

---

## What this does not cover

- **Per-user permissions inside a client** — everyone who can see Shely sees all of Shely. Finer
  than that is a different piece of work and nobody has asked for it.
- **Audit logging.** Worth adding once clients can log in — who looked at what, and when — and not
  in this estimate.
- **Password reset, invites, and the rest of account life.** Supabase gives most of it; somebody
  still has to decide who issues a login and what happens when a client's staff member leaves.
- **What a client is allowed to be told when a number is wrong.** Today the app explains itself
  frankly, including when it is understating. That honesty is a strength internally and a decision
  to make deliberately once the reader is the client being reported on.
