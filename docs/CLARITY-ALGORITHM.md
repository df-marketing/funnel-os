# Clarity — the mapping and the analysis

**Requirement 5.** Two separate algorithms, and confusing them is the failure mode.

**Mapping** is how an export becomes a row: which page, which round, which device. It is code,
it is deterministic, and it is already built.

**Analysis** is when you are entitled to open Clarity at all, and what you may conclude. It is a
decision path, it is the part that was never written down, and it is why a heatmap on its own
proves nothing.

---

## Part A — Mapping: export → page, round, device

Clarity exports carry almost no identity. There is no round, no campaign, and — critically — **no
device inside the file**. Everything below is reconstructed from three signals: the URL pattern, the
date window, and the file name.

### A1 · The page

`pageKeyOf(url_pattern, page_label)` — `lib/import/clarity.ts:140`

The page's identity comes from **the URL pattern**, not from the page label, and not from the
project name. Clarity's project name usually carries the round, which makes two exports of the same
page in different rounds look like different pages — and two different pages in the same round look
like the same one.

The pattern is a regex, so it is reduced to a comparable key:

```
^https\:\/\/memi\.ai\/webinar\-reg.*$   →   memi.ai/webinar-reg
```

| Step | Why |
|---|---|
| strip `^` and `$` | regex anchors, not part of the address |
| unescape `\.` `\/` | Clarity escapes for regex; the page does not contain backslashes |
| drop `https://`, `www.` | the scheme is not the page |
| drop a trailing `.*` | it matches everything, so it distinguishes nothing |
| drop a trailing `/` | one slash is not a different page |
| lowercase | hosts are case-insensitive |

Falls back to the page label only when there is no pattern at all.

> ⚠️ **This is why a second landing page used to delete the first.** Before 9 September the prior-run
> match did not include the page, so importing LP2 for the same round, device and window matched LP1
> as a re-export and replaced it. The identity is now **six** fields — client, round, device,
> `captured_from`, `captured_to`, page key.

### A2 · The round

`roundForWindow(captured_from, captured_to, rounds)` — the round is matched from **the export's own
date window**, because nothing else in the file names one.

This is the single most fragile input, and the fragility is on the human side: **if you set a sloppy
date range in Clarity, the curve files against the wrong round and nothing on screen will say so.**
Set the range to exactly one round's dates.

If no round overlaps the window, the import refuses and says so. It does not guess.

### A3 · The device

`deviceFromName(fileName)` — read off **the file name**, because Clarity puts the device filter in
the download name and nowhere in the file itself.

**Keep the device in the filename.** A file that does not name one records as *all devices*, and the
import warns you. Mobile and desktop scroll behaviour differ enough that a merged curve answers no
question.

### A4 · Export rules, in order

1. Clarity → **Heatmaps** → the landing page
2. Date range = **exactly one round's dates**
3. Set the **device** filter — Mobile or Desktop
4. Metric = **Scroll**. A Clicks export is refused by name
5. Export the CSV and **do not open or re-save it** — Excel rewrites the date line
6. **Keep the device in the filename**

Then: Import tab → panel 5 *Landing page scroll* → drop → **read the diff** → Commit.

The diff names the round it matched and the window it covers. **Read that before committing** — it is
the only place the round match is visible, and the only chance to catch step 2 going wrong.

---

## Part B — Analysis: when you are allowed to open Clarity

Clarity explains a drop-off. It cannot find one. Looking at a heatmap before you have a number that
needs explaining produces a story, not a finding.

### The path, in order

```
1. By month        which month is off?
       ↓
2. By round        which round in it? (or By week, if the product runs weeks)
   or By week
       ↓
3. Drill down      which dimension explains it — audience, ad, landing page?
       ↓
   ┌───┴────────────────────────────────────┐
   │ Is the failing dimension LANDING PAGE? │
   └───┬────────────────────────────────┬───┘
      YES                              NO
       ↓                                ↓
4. Landing page tab                 STOP — Clarity has nothing
   Is Lead Gen % actually low        to say about an audience or
   on one page vs the others?        a creative. Fix it there.
       ↓
      YES
       ↓
5. Compare CLICKS to PAGE VISITS for that page, before opening the curve
       ↓
   If most clicks never became a visit, STOP — the people who would
   explain the gap never reached the page. Look at load time, the
   redirect, and the ad's destination URL instead.
       ↓
6. NOW open Clarity's curve, for that page, that round, that device
```

> ⚠️ Step 5 was added on 11 September after it changed the answer. See the worked example below —
> without it the curve produces a confident, well-evidenced, wrong conclusion about form placement.

**The gate at step 3 is the whole point.** Clarity measures what happens *on a page*. If the
difference is between audiences or between creatives, the page is not the variable and the curve
will show you something true and irrelevant.

### What Lead Gen % has to show first

A page is a suspect only when its Lead Gen % is low **relative to the other pages in the same
round** — not low against some absolute standard, and not low against a different round. Traffic mix
changes between rounds; same-round comparison holds it still.

If there is only one page in the round, there is no comparison, and Clarity can only illustrate —
never diagnose.

### Reading the curve

The scroll curve shows what share of visitors reached each depth. On the same axis, the app draws
**a vertical mark for that round's Lead Gen %**.

The two lines come from genuinely independent sources — Clarity measured the scrolling, the CRM
counted the leads — which is what makes their intersection a finding rather than a restatement.

The strongest reading available:

> **The opt-in form cannot sit below N% of the page.**

If only 40% of visitors reach the midpoint but 55% convert, the form is above the fold and scroll
depth is not the constraint — stop looking at the page. If 70% reach the form's depth and 12%
convert, the drop-off is the form or the offer, not the scroll.

### What the heatmap adds, and what it costs

Clarity has **no heatmap export** and its share links expire, so the heatmap is a screenshot
attached by hand — *Attach Clarity heatmap* beside the curve.

That makes it evidence you cannot re-derive. Attach it when it shows something the curve does not,
and say what that is in the note. A heatmap with no claim attached is decoration.

---

## Worked example — `0926-01`, 11 September 2026

The first real run of this algorithm, kept because it ended somewhere nobody expected and shows
what the curve is and is not for.

**The gate passed.** Two pages in one round, and a real spread: LP1 **15.2%** Lead Gen, LP2
**11.2%**. Landing page was the failing dimension, so Clarity was allowed.

**The hypothesis was that LP2 loses people before the form.** Both pages exported, mobile, 28 Aug –
3 Sep. The curves say the opposite:

| Depth reached | LP1 | LP2 |
|---|---|---|
| 10% | 66.6% | **87.3%** |
| 50% | 53.2% | **85.9%** |
| 100% | 27.2% | **75.1%** |

LP2 holds its visitors far better at every depth. **Three quarters of them reach the very bottom**,
and they still convert worse per click. Scroll depth is not the constraint on either page — LP1
converts 15.2% while 27% reach the bottom, so its form could sit at 100% and still be seen by more
people than convert.

**The answer was upstream of the page**, and the curve is not what found it — the page-visit count
beside it was:

| | Clicks | Clarity visits | Arrive | Leads | Per click | **Per visit** |
|---|---|---|---|---|---|---|
| LP1 | 1,630 | 1,124 | 69% | 248 | 15.2% | **22.1%** |
| LP2 | 922 | 377 | **41%** | 103 | 11.2% | **27.3%** |

**LP2 is the better page.** Once somebody arrives it converts 27.3% against LP1's 22.1% — five
points ahead. The entire Lead Gen deficit, and more, is **545 clicks that never became a page
view**: 59% of LP2's clicks disappear between the ad and the page, against 31% for LP1.

So the fix is not on the page. It is load time, a redirect, or an ad-to-page mismatch that sends
people straight back — and the tools for that are Clarity's **recordings**, the page's own load
timing, and the ad's destination URL, not the scroll curve.

**What this changes about the algorithm:** step 5 gains a check before the curve is read at all.
**Compare clicks to page visits first.** If a large share of clicks never became a visit, nothing
about on-page behaviour can explain the gap, because the people who would explain it were never
there. Reading the curve first would have produced a confident, well-evidenced, wrong answer about
form placement.

---

## Second worked example — `0726-03`, and the one that settles it

Run eight weeks earlier, on the round with the widest Lead Gen spread in the account: LP1 **20.8%**,
LP2 **12.5%**. If the page ever explains a gap, it explains this one.

**Two traps first, both worth knowing.**

The site was rebuilt between July and September. July's pages are `memi-ai-discovery-webinar…`;
September's are `ai-avatar-discovery-webinar…`. **Exporting by remembering a URL from another round
gets you the wrong page** — here it produced a file with one page view.

And the `-2` suffix does not mean LP2. Matched against clicks, July's LP1 is
`memi-ai-discovery-webinar-2` (299 visits against 308 clicks) and LP2 is
`memi-ai-discovery-webinar-v2-2` (38 against 64). **This is why the app derives LP1/LP2 from campaign
names and never from the URL.** A page's address says nothing about which arm of a test it is.

**The curve, unlike September's, does show a real difference:**

| Depth | LP1 (270) | LP2 (33) |
|---|---|---|
| 10% | 64.8% | **74.2%** |
| 50% | 55.9% | 45.2% |
| 70% | **53.3%** | **22.6%** |
| 100% | 29.9% | 12.9% |

LP2 starts ahead and falls off a cliff after halfway — thirty points behind by 70%. In September the
same page held 75% to the bottom, so the rebuild fixed it. A tempting conclusion sits right there.

**It is the wrong one.** Conversion per visitor who actually arrived:

| | Clicks | Visits | Arrive | Leads | **Per visit** |
|---|---|---|---|---|---|
| Jul LP1 | 308 | 299 | **97%** | 64 | **21.4%** |
| Jul LP2 | 64 | 38 | **59%** | 8 | **21.1%** |
| Sep LP1 | 1,630 | 1,124 | **69%** | 248 | **22.1%** |
| Sep LP2 | 922 | 377 | **41%** | 103 | **27.3%** |

**Per-visit conversion is 21–27% in all four.** It does not move between pages, between rounds, or
even when the scroll curve collapses — because the form sits above the collapse, so losing people at
70% depth costs nothing. **Arrival swings from 97% to 41%, and that is the whole of every gap.**

Stated once, for both rounds: **every landing-page gap this client has is arrival, not the page.**
Since July, LP1's arrival has fallen from 97% to 69% — about 500 clicks a round, paid for and never
landing.

⚠️ LP2's July curve is **33 sessions**, far too small to read in detail. It does not weaken the
conclusion, because the conclusion rests on the click-to-visit counts, which are in the hundreds.

**Why this example matters more than the first.** In September the curve agreed with step 5 — LP2
held its visitors and the gap was upstream. Here the curve **disagreed**: it showed a page visibly
failing, with a plausible mechanism and a satisfying before-and-after. Step 5 still overruled it, and
the per-visit figures proved step 5 right. A rule that only ever confirms what you already suspected
has not been tested; this one has.

---

## Current status

**Closed 11 September.** Four real curves are loaded — LP1 and LP2 for `0926-01`, LP1 and LP2 for
`0726-03` — and the two rounds reached the same conclusion by opposite routes: in one the curve
agreed with step 5, in the other it disagreed and was overruled.

🚫 **The `0526-03` test curve should be deleted.** It has no page attached and sits on a round whose
only landing page is the lead form — the one shape this algorithm says cannot be diagnosed. It is a
picture of a working screen with nothing behind it, which is indistinguishable from a broken one.

**Which rounds are worth exporting at all.** Eight of Shely's thirteen fail the gate outright: five
run a single page, and three have pages within 1.4 points of each other. Clarity explains a drop-off;
it cannot find one, so a round where both pages convert the same yields a true and useless curve.
Export when a round has two pages and one converts materially worse — nothing is gained by
backfilling the rest.

**Worth doing in the same sitting:** import a **second** landing page for the same round, device and
dates. Both curves must survive, each tagged with its own URL. That is the regression the six-field
identity exists to prevent, and it is cheap to prove while the first export is still open.
