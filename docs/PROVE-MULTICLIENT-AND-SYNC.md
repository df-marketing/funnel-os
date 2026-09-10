# Proving the multi-client test and the GroundUp sync

Two tasks, and they are not equally provable. Task 1 can be shown end to end.
Task 2 is half built — GroundTruth's half — and the other half is AcqOS's, unwired.
The script says which is which rather than dressing one up as the other.

Sign in as `operator@drivefunnels.com` (staff — sees every client).

---

# TASK 1 · Multiple clients — fully provable, 6 shots

The question was: does this app actually support many clients, or does it merely
contain two? Four clients now exist, deliberately unalike.

## Shot 1 — four clients, one switcher

Top of any screen. Capture the switcher.

> **Memi AI (Shely) · Northsea Supply · Acme Fitness · Zenith SaaS**

Two are real accounts, two are fixtures added to test exactly this.

## Shot 2 — Acme: a different journey, a different currency

Click **Acme Fitness**. Capture the whole window.

```
Ad Impressions 224,000 → Ad Clicks 4,480 → Bootcamp Signups 120
   → Bootcamp Attended 44 → Bootcamp Sale (RM497) 12
spend 4,200.00 MYR · revenue 5,964.00
```

The header says **MYR**, not SGD. The stage names are Acme's own — nobody wrote
code for them, they are rows in a table.

**Every figure is countable by hand**: 4 rounds × 7 days × 2 campaigns = 56 ad
rows at RM 75 = 4,200. 12 sales × 497 = 5,964. There is no seed to trust.

## Shot 3 — the same round code, twice

Still on Acme. Capture the **PERIOD** list in the sidebar.

```
0126-01 (MY) · 5–11 Jan
0126-01 (SG) · 12–18 Jan
0126-02 (MY) · 19–25 Jan
0126-02 (SG) · 26 Jan–1 Feb
```

One client, one code used twice, two markets, different dates. This is
requirement 6 exercised by somebody who is not Shely.

**Second capture:** click **COUNTRY → MY**, then **SG**. Each gives 2 rounds at
2,100.00, and they add to the 4,200 above.

## Shot 4 — Zenith: a different shape again

Click **Zenith SaaS**. Capture the whole window.

```
Ad Impressions 196,000 → Ad Clicks 3,920 → Free Trials 88
   → Demo Booked 32 → Paid Plan ($149) 12
spend 3,360.00 USD
```

Three things at once:
- **USD** — a third currency, and one the database refused until today
- The fourth stage is **Demo Booked**, not attendance. A different journey
- The tab is **By week**, not By round — because Zenith's product says weekly.
  No code decides that

Note **Overall Attendance reads "—"**, not 0. Zenith has no attendance stage, so
the number is *absent*, not zero. That distinction is deliberate everywhere in
this app.

## Shot 5 — Shely, untouched

Click back to **Memi AI (Shely)**. Capture.

```
20,474.78 · 1,889 leads · 682 attendance · 83,927.00 revenue
```

Identical to before any of this. **That is the only figure that mattered.**

## Shot 6 — what the exercise found

Worth a slide of its own, because it is the actual result. Three bugs, none
findable with only two clients:

1. **The currency check allowed only SGD and MYR.** A client billing in USD
   could not be onboarded without a schema migration. Onboarding day would have
   been an emergency.
2. **The lookup refresh had never once worked.** Every import since it was built
   silently skipped it, leaving new campaigns unattributed, with the only trace
   in a server log.
3. **A total no column accounted for.** 44 attendances against four rounds each
   reading "—".

All three are fixed. None would have surfaced without a third client.

---

# TASK 2 · The GroundUp sync — half built, and say so

**What is done: GroundTruth's half. What is not: AcqOS's half.** An end-to-end
onboarding cannot be photographed today, and a screenshot implying otherwise
would be the wrong kind of proof.

## What was found

The wire between the two systems **already existed** — AcqOS can push a client
and its funnel to GroundTruth, and has been able to for weeks. It was being done
by hand instead.

But the endpoint was never the missing piece. **The missing piece is the handle**
— the short name (`shely`, `acme_fitness`) that both systems must agree on. It
is stored in AcqOS and written by nobody; somebody sets it in SQL.

And a hazard underneath: GroundTruth deliberately treats a repeated push as a
retry — it replaces the funnel and reports success. Correct for a retry.
**Catastrophic for a collision**: two companies whose names both reduce to
`acme`, and the second push silently replaces the first one's reporting. The
short name was the only identity GroundTruth held, so it could not tell them
apart.

## Shot 7 — the guard, and why it needs testing

In the terminal:

```bash
npm run test:claim
```

Capture the output. **9 assertions.** The pair they exist for looks identical
from outside:

```
same handle, same AcqOS client        → a retry, proceed
same handle, different AcqOS client   → a collision, refuse
```

Backwards, that either breaks every retry or hands one client's reporting to
another — with no error, on a screen that looks entirely correct. That is why
this logic is tested rather than trusted.

## Shot 8 — the endpoint is live and refuses properly

```bash
curl -i -X POST https://funnel-os-red.vercel.app/api/integration/client-handle \
  -H "Content-Type: application/json" -d '{}'
```

Capture. **`401 unauthorized`** — it exists, it is deployed, and it will not
talk to anyone without the shared key.

## Shot 9 — the second identity is stored

In the SQL editor:

```sql
select client_id, currency, source_client_id, claimed_at
  from client_flags order by client_id;
```

Four rows, `source_client_id` null on all of them — nothing claimed yet, which
is correct. That column is the second identity that makes a retry
distinguishable from a collision.

## What cannot be shown yet, and by whom

- **AcqOS minting the handle at signup** — their side, specified, unwritten
- **AcqOS calling the claim endpoint** — same
- **A client onboarded once and appearing in both systems** — needs both halves

The claim endpoint also cannot be demonstrated from this laptop: it writes with
the service-role key, which lives only on Vercel. The natural demonstration is
AcqOS calling it, which is their job anyway.

---

# The honest summary for a supervisor

**Multi-client: proven.** Four clients, three currencies, two cadences, three
journey shapes, colliding round codes — and the exercise found three real bugs
that only a third client could expose.

**Onboard-once: half done.** The wire already existed; the missing piece was
never the endpoint, it was the shared handle and a collision hazard underneath
it. GroundTruth's half is built and tested. AcqOS's half is specified and
waiting.

**Same login: not started, and blocked on a business question rather than a
technical one.** AcqOS today gives one login per client — two people at the same
company share it. GroundTruth already supports one login each. Adopting AcqOS's
identity as-is would *downgrade* GroundTruth. So: does a client's team need
individual logins? If yes, AcqOS needs a schema change and that is the first
item. If one shared login is genuinely acceptable, this gets much simpler — but
it should be decided out loud rather than inherited from whatever gets built.
