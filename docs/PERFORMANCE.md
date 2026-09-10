# Why the app stalls, and what is left to do about it

**Measured 10 September 2026, against production through the app's own key.**

Short version: **the query work is done and the instance is the problem.** A burstable free-tier
Postgres, run hard for a few minutes, throttles to roughly a hundredth of its idle speed and every
screen fails. Nothing in the schema fixes that.

---

## The measurement that settles it

A five-row read from a twenty-one row table, and a ten-row table, under two conditions:

```
sustained load          rounds limit 5   8.0s · 11.8s · 20.1s
                        dimension_values 30s (timeout) · 30s (timeout) · 0.56s

after 60 seconds idle   rounds limit 5   0.23s · 0.09s
                        mv_campaign_dimensions (52 rows)  0.20s
```

**The same trivial query is 0.09 seconds idle and 20 seconds under load.** It is not a query that
can be optimised — it reads five rows by primary key. It recovers on its own, completely, given a
minute of quiet.

That is a burstable instance exhausting its CPU credits and dropping to baseline. Everything
confusing about the last two days follows from it:

- Queries that were fast in isolation and timed out in sequence
- Pages that failed, then worked, with no change in between
- A 53-second page load followed by a 0.15-second one
- Every "it recovered on its own" note in the migration files

Several of the migrations written yesterday were chasing this shadow. Two were real
(`v_campaign_dimensions` rebuilt four times a page, `fo_stage_extras` scanning to produce `{}`);
one of them took the app down and had to be reverted. The pattern to learn from is that
**measurements taken during a burst are not measurements.**

---

## What the query work actually achieved

Real, and worth keeping. Measured idle, before and after the campaign-lookup cache:

| | before | after |
|---|---|---|
| `v_campaign_dimensions` | 0.23s | **0.12s** |
| `v_attributed_events` (count) | 0.60–0.79s | **0.44s** |
| `fo_cut v_metrics_total` | 1.02–1.72s | **0.59s** |
| `fo_cut v_journey_strip` | 1.56s | **0.88s** |
| `fo_cut v_metrics_by_round` | 1.12–1.18s | **0.89s** |

And the earlier fixes, from the day before:

| | before | after |
|---|---|---|
| `v_round_assets` (This round) | 16.7s | 2.96s |
| `v_client_countries` (every page) | 2.75s | 0.14s |
| `v_round_markets` | 1.99s | 0.13s |
| Country filter | timeout | ~1s |

**Real page loads at a single user's pace are now 0.3–1.6 seconds**, and 0.15–0.2 once cached.

---

## What is left, in order of value

**1. Size the database.** This is the whole remaining problem. The app is 52 campaigns, 1,855 ad
rows and 3,035 events — small data by any measure — and it does not fit in a free-tier burst
budget. Two people clicking at once will reproduce every failure above. Do this before FWD is
onboarded, not after the first complaint.

**2. Do not read the statement timeout as a safety net.** It was raised from 3s to 15s so slow
queries degrade instead of failing. That is right for one user and wrong under load: a query killed
at 3s frees its connection, and one that runs for 15 holds it, so a burst queues instead of
shedding. Revisit it once the instance is sized.

**3. The remaining floor is architectural, not fixable by tuning.** About 0.6–0.9s per read, made of
six view layers at 0.1–0.2s each — `v_event_attribution` → `v_attributed_events` → `v_events` →
metric view → `fo_cut`. Each layer is correct and none is wasteful now. Collapsing them would mean
rewriting the attribution layer, which is the newest and least-proven code in the system. Not worth
it at this size; worth revisiting at ten clients.

**4. `v_contact_entry` is the one lookup that cannot be cached.** It calls `fo_attribution_model()`,
so its rows differ per credit model. A materialised copy would freeze one model and serve it to
everyone — the Credit selector would keep moving while the numbers stopped following it. If anybody
later tries to speed it up the same way `v_campaign_dimensions` was sped up, that is the trap.

---

## How to measure this app without fooling yourself

Everything above was got wrong at least once by measuring badly.

- **Space requests by ten seconds or more.** A tight loop measures the throttle, not the query.
- **Read the second number, not the first.** The first load of any filter combination is a cold read;
  every one after is cached for thirty minutes.
- **Verify through the anon key, never the SQL editor.** The editor is a superuser and sees rows
  row-level security hides from the app. That has already produced one false pass — zero mismatches
  in the editor, 44 out of 46 through the app's key.
- **Check the distribution, not the sum.** Both faults found in review left `20,474.78` intact while
  everything underneath was wrong.
