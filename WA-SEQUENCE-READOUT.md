# WhatsApp reminder sequence — A vs B

**4 September 2026.** Verified against production: https://funnel-os-red.vercel.app

---

## The answer

| | Leads | Attended | Show rate |
|---|---|---|---|
| **WA Sequence A** | 179 | 49 | **27.4%** |
| **WA Sequence B** | 178 | 48 | **27.0%** |

**357 people. A 0.4-point gap. That is a coin flip.**

And the winner flips between rounds:

| Round | Sequence A | Sequence B | Winner |
|---|---|---|---|
| July 2026 | 29.4% | 29.4% | tied |
| August 2026 | 20.9% | 19.0% | A |
| **Combined** | **27.4%** | **27.0%** | — |

**Neither version of the reminders performs better.** Keep whichever is easier to maintain.

The honest read is stronger than "A won by 0.4%": with 357 people split two ways, a real difference
would have to be roughly 10 points before it could be told apart from chance. This test could not
have detected anything smaller — so it did not fail, it was never big enough to succeed.

---

## Why show rate is the only fair measure

The reminder messages go out **after** somebody has already registered.

A reminder sequence cannot buy more leads. It can only get more of the leads you already have into
the room. So comparing lead counts between arms says nothing — the arm with more registrations
will simply have more attendees.

**Show rate — attendance ÷ leads — is the comparison.** It is what the app shows by default on that
tab, and the only reading that can answer the question that was asked.

---

## Where the data comes from

**Your own round spreadsheets. Nothing was inferred, tagged, or invented.**

Open `0726-02 Shely's Funnel Metrics.xlsx` → sheet **`Registration List`** → column **`WA Sequence`**.
There is also a sheet named `Check WA Sequence`. One value per person:

| First Name | Email | Opt In Status | **WA Sequence** |
|---|---|---|---|
| Aminordin omar | aminordin@gmail.com | Opted In | **WA Sequence B** |
| Henry ng | henry@goacademyai.com | Opted In | **WA Sequence B** |
| Caroline heng | caroline_heng_pl@tecsg.com.sg | | **WA Sequence A** |
| Helen ho | helenhcy@yahoo.com.sg | Opted In | **WA Sequence A** |

The import reads that column and groups people by whatever text is in the cell. It never guesses
and never reads it out of GoHighLevel tags.

**One thing we cannot tell from the file:** whether GoHighLevel wrote that column automatically or
somebody typed it. Worth knowing — if it is manual it can go wrong, and if it is automatic more
tests are cheap.

---

## Which rounds have it — all 27 files scanned

| Round | Registration List | `WA Sequence` column |
|---|---|---|
| `0526-02`, `0526-03` | present | **no** |
| `0626-01`, `0626-02` | present | **no** |
| `0726-01` | present | **no** |
| **`0726-02`** | present | **yes** — 52 A / 58 B |
| **`0726-03`** | present | **yes** — 40 A / 37 B |
| **`0726-04`** | present | **yes** — 44 A / 41 B |
| **`0826-01`** | present | **yes** — 43 A / 42 B |
| `0826-02`, `0826-03` | **missing** — file has only `Leads & Attendance` | unknown |
| `0926-01` | **missing** — file has only `Sheet1` | unknown |

Two different situations:

- **The first five rounds genuinely did not run the test.** Full Registration List, no such column.
- **The last three cannot be checked at all** — those files have no Registration List sheet.

### What we need

**The proper Registration List export for `0826-02`, `0826-03` and `0926-01`.**

The same request closes two open items at once: it tells us whether a sequence test ran in those
rounds, **and** it closes the last ~34 leads missing from the lead count.

---

## How to see it in the app

1. Open https://funnel-os-red.vercel.app
2. Journey strip → **Live Webinar Attendance**
3. **Period → All time** ← this matters
4. **Table** for the numbers, **Graph** to see it drawn

**Set the period to All time.** The test ran in July and early August only. On September the tab is
empty — correctly, because the test was not running then. It now says so in words and names the
rounds the data is in, rather than showing a blank.

---

## Running the next test

Fill the same column in the Registration List export for the rounds it runs in. That is all.

The group name is **whatever text is in the cell**, so `Email Sequence C` becomes its own arm
automatically. Email sequences, subject lines, send times — any of them work. **No code change and
no request to the dev side.**

These column headings are all recognised:

`wa sequence` · `whatsapp sequence` · `email sequence` · `reminder sequence` · `sequence` ·
`test variant` · `ab test` · `experiment`

### If you want the next test to actually settle something

- **Change one thing only**, so a difference has a single cause
- **Run it across more rounds.** 357 people can only detect a large gap; roughly 1,000 per arm
  would resolve a 5-point difference
- **Decide the winning margin before starting.** "A wins if it is 5 points ahead" beats reading
  whatever gap turns up

---

## One detail on how it is counted

The arm is recorded **per person, per round**.

Somebody in Sequence A for July who was in no test in May counts for A in July and for nothing in
May. Otherwise the test would take credit for a class that ran before it was written — which was a
real bug, and it moved the headline: A read 31.8% against a true 27.4%, B read 33.7% against 27.0%.
Both arms flattered, and the gap between them distorted.

The figures at the top of this page are the corrected ones.
