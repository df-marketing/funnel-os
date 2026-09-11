# Proving the nine requirements — the screenshot script

**For:** a supervisor review.
**Rewritten:** 11 September 2026, against production, after requirements 3, 4 and 5 closed.

Every step names what to click, what to capture, and **what the picture proves**. Several cannot be
proven by photographing the obvious thing, and those are called out — a screenshot of a screen that
would look identical if the feature were broken proves nothing.

Base URL `https://funnel-os-red.vercel.app`. Client **Memi AI (Shely)** unless stated.

**The figures every shot must leave alone:**

```
spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00 · ROAS 1.80 · CPA 365.62
```

**Months:** May 2,447.26 · Jun 2,180.32 · Jul 6,913.25 · **Aug 4,997.27** · Sep 3,936.68 — and they
sum to 20,474.78 exactly.

> ⚠️ **August changed on 11 September.** A round crossing a month boundary used to be counted in
> both months, so August read 8,933.95. **It is 4,997.27.** Any earlier deck or report showing the
> old figure is wrong, including Report 14.

---

## Before you start

**Load every page once to warm it, then go back and shoot.** First load of a filter combination
reads the database and can take a few seconds; every load after is 0.15–0.2s. Otherwise half the
shots are of a spinner and the review becomes a conversation about speed.

**Everything here is live on production.** Requirement 3's Rules screen and the Clarity curves both
shipped on 11 September and are verified against production data.

**One requirement is not fully photographable, and it is 4.** Its journey stages are — that is the
half every client needs. Its custom *ads measures* are not: the figure reaches the data and the
table that would draw it has a fixed row list. Section 4 says exactly where that stops.

---

## 1 · Qualitative data visualisation ✅

**Go to** `?client=shely&view=forms` · **Capture** the whole pane.

**It proves it** if three questions appear — profession, main challenge, free webinar — each on
**976 leads**, and **"Tags" and "Last Activity" are absent**. Those two were being reported as
questions until 9 September; if either is back, the importer has regressed.

**Say this before they ask:** it covers **976 of 1,889 leads (52%)**, and **"Others" is the top
profession at 413 (42%)**. A supervisor who finds those numbers themselves will discount the screen.

**The use-case question the meeting asked is a product question, not a build one.** The answers are
stored, split and countable today. What to *do* with them — audience naming, creative angles,
qualifying questions — is a decision nobody has made yet, and the app is not blocking it.

---

## 2 · Attribution model ✅

**Go to** `?client=shely&view=round`. The **CREDIT** block is in the left sidebar.

**Capture three shots** of the same tab: **Entry**, **Last touch**, **Even split**.

⚠️ **Include the round columns, not just the header.** The total is 83,927 in all five — and that on
its own is also what a selector wired to nothing would show. The proof is that **per-round revenue
moves while the total does not.** `0726-02` is clearest:

```
entry        23,173.00
entry_paid   23,173.00
last_touch   13,876.00
last_paid    14,173.00
even_split   18,648.25
```

Credit moves between rounds. It is never created or destroyed.

**On "Previous Paid Ads is no more":** the bucket already holds **zero rows** — all 113 sales sit in
Paid Ads (64), Organic (30), AOAI (16), Unattributed (3) = 83,927. Retiring it is a code cleanup
with no number attached, and it is queued behind stamping the model onto frozen reports.

---

## 3 · Source attribution ⏳ *needs the deploy*

**Two halves. The first is provable now.**

**Now — the sources themselves.** `?client=shely&view=source` · capture the table.

**It proves it** if five sources appear and **spend sits only on Paid Ads**, the others **blank, not
`0.00`**. Blank means absent; a zero would claim Organic was advertised against and returned nothing.

```
Paid Ads 1,520 · Organic 307 · AOAI 61 · Tracking not captured 1 · Unattributed 0  =  1,889
```

**Second shot:** click **SOURCE → Organic** and capture the journey strip. The numbers at the top
must drop with the table. A strip still reading 1,889 over a filtered table is the specific bug this
app had once.

**⏳ After the deploy — adding one.** This is what the meeting actually asked: *how do we create a
new source, like an affiliate programme?*

**Go to** `?client=shely&view=rules` (staff only) → the **Source** tab.

**Capture** the "What your data suggests" block. It reads what is already there and offers it:

```
[Create Organic]     455 rows arrived with source "Organic", which no rule names yet
[Create Paid Ads]    437 rows arrived with source "Paid Ads", which no rule names yet
[Create AOAI]        108 rows arrived with source "AOAI", which no rule names yet
```

**It proves it** because nobody typed a rule. To show affiliate specifically, add one by hand:
**source column · is exactly · `affiliate_partner`** — then capture it sitting in the order list
above the catch-all.

**Say this:** changing a rule **restates every past round instantly** — the raw campaign name and
source are stored and the label is derived at read, so nothing is re-imported.

---

## 4 · Dynamic customer journey 🟡 *one half proven, one half still not on screen*

**The stages — photograph this.** `?client=shely&view=acqos` for the declared stages, plus the
client switcher showing **Memi AI** and **Northsea Supply** running different journeys — six stages
against five. Stages are rows, so a new client's journey needs no deploy. That half works and always
did.

**The ads measures — do not photograph, there is nothing to see.** A client can declare an ads
figure the four fixed columns do not carry — video views, ThruPlays — and it is captured, stored and
now carried all the way through the read. It still does not appear on a screen.

**What was fixed on 11 September, and what was not.** `fo_stage_extras` read `source = 'events'` and
nothing else, so a declared ads measure was captured, stored and dropped on the floor. 20260911110000
added the missing branch, and the figure now reaches the cut correctly — measured on `acme_fitness`:

```
ACME-MY-0126-01   m.vv = 1234        the round it was put on
another round     m.vv = undefined   absent, not zero
total             m.vv = 1234        and it sums
```

**But `SPINE` is a hard-coded array** — `lib/funnel/spine.ts`, twenty-nine keys in a closed
`MetricKey` union. A declared metric is not one of them, so the By round table cannot draw a row for
it. The number arrives and nothing renders it.

> ⚠️ **This document previously said requirement 4 was closed, and told you to demo it on a client
> called `acme`.** Both were wrong. The client id is `acme_fitness`, and the demo would have produced
> a correct figure on a screen with no row to show it. The data half closed; the render half never
> did, and the original description — *"it stores correctly, but it doesn't display yet"* — is still
> the accurate one.

**What closing it takes:** `SPINE` becomes the fixed list plus the client's declared metrics, and
`MetricKey` widens from a closed union to `string`. That union is a typed contract across the table,
the chart and the analysis code, so it is real work rather than a one-liner.

**Say this:** the journey stages are dynamic today and that is the half every client needs. The ads
measures are dynamic as far as the database; the table that draws them still has a fixed row list,
and no client has asked for one — FWD was checked directly and buys on clicks.

---

## 5 · Microsoft Clarity ✅ *closed 11 September, with a real finding*

**This is no longer "built, never fed".** Two real exports are committed against round **`0926-01`**
and they produced a conclusion worth showing.

**The algorithm is `docs/CLARITY-ALGORITHM.md`.** Screenshot the decision path from it — that is what
the meeting asked for, and the gates are the point:

```
month → round → drill down → is the failing dimension LANDING PAGE?
  → is its Lead Gen % low against the OTHER pages in the same round?
    → do most clicks actually become page visits?        ← added 11 Sep
      → only now, read the curve
```

**Go to** `?client=shely&view=analysis` with **`0926-01`** selected, step 3.

**Capture** both curves. It proves it if each is tagged with **its own URL** — two landing pages,
one round, one device, one window, both surviving. Until 9 September the second import silently
deleted the first.

**The finding, and lead with it:**

| | Clicks | Visits | Arrive | Leads | Per click | **Per visit** |
|---|---|---|---|---|---|---|
| LP1 | 1,630 | 1,124 | 69% | 248 | 15.2% | **22.1%** |
| LP2 | 922 | 377 | **41%** | 103 | 11.2% | **27.3%** |

**LP2 is the better page.** It converts 27.3% of arrivals against LP1's 22.1%. Its entire Lead Gen
deficit is **545 clicks that never became a page view** — 59% lost between ad and page, against 31%
for LP1. The fix is load time, a redirect or an ad-to-page mismatch; **it is not on the page.**

The curves say the same thing from the other side: LP2 holds **87.3%** at a tenth of the page
against LP1's 66.6%, and **75.1%** reach the bottom against 27.2%.

⚠️ **State the caveat before anyone finds it:** scroll depth is a percentage of page height, so LP2
may simply be a shorter page. That does not weaken the conclusion — the click-to-visit gap is
measured, not inferred — but do not let "75% reach the bottom" be read as engagement.

**⏳ The heatmap** is a screenshot attached by hand (*Attach Clarity heatmap*), which needs the
deploy. The two PNGs are already exported and waiting.

---

## 6 · Round naming separation ✅

**Go to** the client switcher → **Northsea Supply** → capture the **PERIOD** list.

**It proves it** if both appear:

```
0526-01 (MY) · 4–10 May
0526-01 (SG) · 11–17 May
```

One code, two markets, different dates, nothing renamed. The unique key is
`(client, product, market, code)`; the obvious version without `market` would have rejected the
second row.

**Second shot:** Shely's own PERIOD list shows **no market at all** — `0526-02 · 13–19 May`. One
market means nothing to disambiguate. The market appearing exactly when it starts meaning something
is the design, not an inconsistency.

**Third, and it is the load-bearing one:** both demo rounds file under **May**. The month is read
from `code`, not from `round_id` — `DEMO-MY-0526-01` has no `MMYY-NN` at the front, so if the month
still parsed the id, both would land nowhere.

**Say this:** the ads importer resolves the **market first and the date second**. A campaign reading
`DF_MY_..._0526_01` can only match the Malaysian round. Date-first would have produced silently
wrong spend the day two markets overlapped.

---

## 7 · Personalisation ✅

**Go to** `?client=shely&view=round`, click **AUDIENCE → Cold_Broad**.

**Capture two shots:** the round tab filtered, then **switch to another tab with the filter still
set.**

**It proves it** if the filter **follows you across tabs** and the journey strip narrows with it:

```
all audiences         spend 20,474.78 · leads 1,889 · rev 83,927
Cold_Broad            spend  3,373.84 · leads   230 · rev  6,667
Cold_BusinessOwners   spend  3,679.49 · leads   252 · rev  4,173
```

**For the ads × audience half the meeting asked about:** with the audience filter set, open the
**Ads** tab — creatives are now shown for that audience only. Landing page × audience is the same
move on the **Landing page** tab.

Note this deliberately **reverses** the older "an asset does not follow you to another tab" rule.
Filters follow; drill-downs stay local.

---

## 8 · Cross-round exposure / ads event tracking ✅ *SQL only*

Nothing was built, correctly: a person registering for two rounds already writes two rows, each
carrying **its own ad, ad set and campaign**. That is why those columns sit on the event and not on
the contact — storing them on the person would collapse May's ad and June's ad into one.

```sql
select contact_id, count(distinct round_id) as rounds
  from events
 where event_type = 'lead'
 group by contact_id
having count(distinct round_id) > 1
 order by rounds desc
 limit 10;
```

**It proves it** if contacts appear with 2 and 3 rounds — there are **56 in the first 2,000 lead
rows**, one of them in three.

**Say this about cohort analysis:** the data supports it and there is **no screen**. When one is
built it must state that **Meta gives no per-person impressions**, so exposure is only observable
when a click became a registration — any cohort view understates and has to say so.

---

## 9 · Drop `is_lead` ✅

**Capture three failures**, which is what proof of a removal looks like:

```sql
select is_lead        from events limit 1;   -- ERROR: column does not exist
select country        from events limit 1;   -- ERROR: column does not exist
select close_round_id from events limit 1;   -- ERROR: column does not exist
```

**Then capture the totals on the same screen if you can.** A dropped column that took a number with
it is the only way this could go wrong, and the pair of pictures rules it out.

---

## Worth one extra shot: the country filter

It broke and was rebuilt on 9 September.

```
MY       1 round   ·    989.53 · 247 leads   0926-01
SG      12 rounds  · 19,485.25 · 1,601 leads
                     ─────────
                     20,474.78   exactly the account total
```

**MY is one round and that is correct.** There are exactly two MY campaigns in the account, both in
`0926-01`. An earlier note claimed four; that number came from a script counting the keys of an
error object and was never real.

---

## If somebody asks why a page was slow

Say it before they ask.

**Every screen is 0.15–0.2s once loaded.** First load of a filter combination reads the database and
can take a few seconds; the result is cached for thirty minutes. The floor is about **1.5s** for any
read and a page fires several at once — measured today: 0.6–1.8s typical, `v_round_assets` 3.0s.

That floor is the honest open item. **52 campaigns and 3,000 events should not cost 1.5 seconds on
any plan.** It is an instance-size question, not a query-tuning one: seven query fixes on 9
September took the app from failing to working and the floor barely moved.

---

## The one rule behind all nine

**A total that does not move is not proof.**

Every fault found in review left `20,474.78` intact while something underneath was wrong — row-level
security hiding a table from the app but not the editor; credit re-filed between rounds that still
summed correctly; and on 11 September, two Clarity curves that imported cleanly, reported the right
sessions, and **contained no readings at all** because the write path and the read path had drifted
apart. That one survived 683 tests, because the tests asserted the table nothing reads.

So: **check the distribution, not the sum.** Read anything you verify **through the app**, never
through the Supabase SQL editor — the editor connects as a superuser and sees rows the app cannot.
That difference has already produced one false pass: zero mismatches in the editor, **44 of 46**
through the app's key.
