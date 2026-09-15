# The freeze guard — exact shape for AcqOS

**Status: built, tested, and described here from the shipped code.** Nothing below is aspirational;
every field was read out of the route that returns it.

**Additive.** `contractVersion` stays **1**. No existing code, status or `recover` value changed.

---

## 1 · Why, in one paragraph

`isClosedDay` / `isClosedMonth` asked whether the period was **over**. Nothing asked whether the
data had **arrived**. Those are different questions, and `force` answered only the first — so a
period could be forced open-early *and* a period long finished could be frozen against files that
stopped halfway through it. The second case never announces itself: the numbers are real, they are
just short.

AcqOS's audit found `0926-02` frozen at 01:19 on the first day of its own window, six days before it
ended, all five steps reporting no reading, storing `weak_stage: "Leads"` anyway.

**Those rows are not GroundTruth's.** GT's `period_insights` held two records across all clients —
both `shely / month 2026-05`, frozen 26 and 27 August, `anySourceStale: false`, zero steps without a
reading. No September freeze and no `0926-*` freeze exists anywhere in GT. Checked before accepting
the finding.

**The defect was here too.** `round-insight/route.ts:288` and `month-insight/route.ts:345` both read
`if (!body.force && …)`, so `force` skipped the only gate, and no gate existed for staleness at all.
The same hole in both systems, found by neither alone.

---

## 2 · The two gates, and why they are two

| gate | question | override |
|---|---|---|
| **A** — existing, unchanged | Is the period **over**? | `force: true` |
| **B** — new | Has the **data reached** the end of it? | `acknowledgeStale: true` |

**`force` does not open gate B.** That is the whole design. `force` says *"I know it is not over."*
`acknowledgeStale` says *"I know the data is short."* Conflating them is the defect — a caller
passing `force` for a legitimate reason silently acquires permission to freeze against missing data.

Gate A still returns `422` with a prose `error`, exactly as before. **No existing caller changes
behaviour at gate A.**

---

## 3 · The refusal

```http
POST /api/integration/round-insight   (and /month-insight)
```

```jsonc
// 409
{
  "ok": false,
  "code": "period_not_final",
  "recover": "import-first",
  "retry": "import the missing data, then freeze — or pass acknowledgeStale: true to freeze the gap deliberately",
  "error": "Round 0926-02 ended 2026-09-14, but imported data stops 2026-09-02, before this period ends 2026-09-14. Freezing now would store a reading of a window the data does not cover.",
  "periodKey": "0926-02",
  "reason": "imported data stops 2026-09-02, before this period ends 2026-09-14",
  "completeThrough": "2026-09-14",
  "reach": "2026-09-02",
  "override": "acknowledgeStale"
}
```

| field | meaning |
|---|---|
| `code` | `period_not_final` — branch on this, or on `recover` |
| `recover` | `import-first` — **new value in the recovery vocabulary**, see §5 |
| `completeThrough` | the date the data must reach before this period can be frozen cleanly |
| `reach` | where the data actually stops, or `null` if no source can say |
| `reason` | the two dates in one sentence, safe to show a person |
| `override` | names the field that bypasses it, so the escape hatch is discoverable |

### When `reach` is unknown

A source with no `coverage_end` makes reach `null`, and that also refuses:

```
"reason": "no source reports a coverage end, so there is no way to tell whether the data reaches this period"
```

Blank is not zero and it is not permission. Not knowing refuses.

---

## 4 · The override

```jsonc
POST { "acknowledgeStale": true }
```

Freezes anyway — **and records it**. The stored `note` gains:

```
Frozen with an acknowledged gap: imported data stops 2026-09-02, before this period ends 2026-09-14.
```

So an acknowledged gap is still legible in three months. It composes with `force`, which appends its
own sentence; a freeze that was both early and short says both.

---

## 5 · The one thing that is not purely additive

`recover` gains a fourth value: **`import-first`**, joining `mint-new-handle`, `use-held-handle`,
`claim-first`.

A caller doing `switch (recover)` with no `default` will fall through on it. **But it only ever
arrives attached to a code you also do not know**, so any caller that handles an unrecognised `code`
safely already handles this safely.

`contractVersion` stays `1`. It is announced here rather than versioned because you are reworking
your gate to match, and a version bump would tell every *other* caller something breaking happened
when nothing did.

> This is exactly what the frozen-copy mechanism is for. Adding `period_not_final` was *announced*
> by `scripts/test-refusals.mts`; widening the `recover` vocabulary **failed** it, and had to be
> written into the frozen block by hand. The test distinguished the additive part from the
> caller-visible part without anyone having to notice.

---

## 6 · Which date a period must be complete through

| kind | `completeThrough` |
|---|---|
| round | the round's `end_date` — exact |
| month | the month's last day |

`GET /api/integration/periods` is **stricter for months**: it also waits for a round anchored to a
month that runs *past* the month end, so a month can pass this gate and still read `incomplete`
there. Deliberate — the guard costs no extra query on a write path, and it closes the failure that
was actually observed. **If you want the strict answer, read `/periods` first.**

The guard reads `lastObservationDate` out of **the payload being frozen**, not a fresh query, so the
gate and the record can never disagree about how far the data reached.

---

## 7 · What you should do

1. **Call `GET /api/integration/periods?clientId=…` before freezing.** `finalPeriods` is the list
   that will not be refused. This is the cheap path — no 409 round-trip.
2. **Handle `period_not_final`** on both freeze endpoints. Treat it as *import, then retry*, not as
   an error to surface.
3. **Do not reach for `acknowledgeStale` as a retry.** It is for a deliberate decision by a person
   who knows the month will never fill. An automated loop that sets it has reintroduced the bug.
4. **Check whether your own frozen payloads carry `anySourceStale`.** GT's do, which is how a stale
   freeze stays detectable after the fact. If yours do too, you can find every affected record
   rather than guessing which ones are wrong.

---

## 8 · Evidence

| claim | where |
|---|---|
| gate A unchanged | `round-insight/route.ts:288`, `month-insight/route.ts:345` |
| gate B, `force` does not open it | `round-insight/route.ts:299`, `month-insight/route.ts:358` |
| the decision, pure and shared | `lib/integration/periods.ts` → `freezeRefusal()` |
| reach read from the payload | `lib/integration/coverage.ts` → `reachOf()` |
| the code and its `recover` | `lib/integration/codes.ts` → `REFUSALS.period_not_final` |
| the contract cannot drift | `scripts/test-refusals.mts` — 24 assertions |
| the 0926-02 case, pinned | `scripts/test-finalised.mts` — 39 assertions |

**Not verified:** the guard has not been exercised against a live stale freeze on production, because
doing so means writing a deliberately-wrong record at a real client. It is covered by unit tests over
the pure decision and by typecheck at the call sites. If you want it proven end to end, freeze a
throwaway period and send the 409 back.
