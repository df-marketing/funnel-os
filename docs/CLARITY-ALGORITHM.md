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
5. NOW open Clarity, for that page, that round, that device
```

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

## Current status

**Built and never fed.** The import, the curve, the Lead Gen % comparison and the heatmap upload all
work. There is **one test curve on `0526-03` with no page and no heatmap.**

🚫 **Do not screenshot it.** It would be a picture of a working screen with no data behind it, which
is indistinguishable from a broken one.

**To close requirement 5:** export one real curve for `0526-03` (23–27 May 2026) following A4, walk
it through Part B, and capture the diff before committing plus the curve after.

**Worth doing in the same sitting:** import a **second** landing page for the same round, device and
dates. Both curves must survive, each tagged with its own URL. That is the regression the six-field
identity exists to prevent, and it is cheap to prove while the first export is still open.
