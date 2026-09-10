# Proving the nine requirements — a screenshot script

**For:** a supervisor review.
**Verified:** 10 September 2026, against production through the app's own key.

Every step names what to click, what to capture, and **what the picture proves**. Three of these
cannot be proven by photographing the obvious thing, and those are called out — a screenshot of a
screen that would look identical if the feature were broken proves nothing.

Base URL `https://funnel-os-red.vercel.app`. Client **Memi AI (Shely)** unless stated.

**The figures every shot must leave alone:**

```
spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00 · ROAS 1.80 · CPA 365.62
```

---

## Before you start — load each page twice

The first load of any filter combination is slow: it reads the database, and on the current
instance that can take anywhere from two to forty seconds. Every load after it is **0.15–0.2s**,
because the result is cached for thirty minutes.

So: **click through everything once to warm it, then go back and take the screenshots.** Otherwise
half your shots are of a loading page, and the review turns into a conversation about speed instead
of about the nine requirements.

---

## 1 · Qualitative data visualisation — READY

**Go to** `?client=shely&view=forms`

**Capture** the whole pane.

**It proves it** if three questions appear — profession, main challenge, free webinar — each on
**976 leads**, and **"Tags" and "Last Activity" are absent**. Those two were being reported as
questions until 9 September; if either is back, the importer has regressed.

**Say this before they ask:** it covers **976 of 1,889 leads (52%)**, and **"Others" is the top
profession at 413 (42%)**. A supervisor who finds those numbers themselves will discount the whole
screen.

---

## 2 · Attribution Model — READY

**Go to** `?client=shely&view=round`. The **CREDIT** block is in the left sidebar.

**Capture three shots** of the same tab: **Entry**, **Last touch**, **Even split**.

**Include the round columns, not just the header.** The total is 83,927 in all three — and that on
its own is also what a selector wired to nothing would show. The proof is that the **per-round
revenue moves** while the total does not. `0726-02` is the clearest:

```
entry        23,173.00
entry_paid   23,173.00
last_touch   13,876.00
last_paid    14,173.00
even_split   18,648.25
```

Credit moves between rounds. It is never created or destroyed.

---

## 3 · Source Attribution — READY

**Go to** `?client=shely&view=source`

**Capture** the table.

**It proves it** if five sources appear and **spend sits only on Paid Ads**, with the others
**blank — not `0.00`**. Blank means absent. A zero would claim Organic was advertised against and
returned nothing.

```
Paid Ads 1,520 · Organic 307 · AOAI 61 · Tracking not captured 1 · Unattributed 0  =  1,889
```

**Second shot:** click **SOURCE → Organic** and capture the journey strip. The numbers at the top
must drop with the table. A strip still reading 1,889 over a filtered table is the specific bug this
app had once.

---

## 4 · Dynamic Customer Journey — READY TO EXPLAIN, NOT TO PHOTOGRAPH

**What is built:** a client's journey stages are rows, not code. `event_types` holds what a person
can do, `journey_metrics` maps a stage to one, so adding "policy issued" is two rows and no deploy.

**Capture** `?client=shely&view=acqos` for the declared stages, and the client switcher showing
**Memi AI** and **Northsea Supply** running different journeys.

**What is deferred, and say so plainly:** a client can declare a custom *ads* measurement — video
views, ThruPlays — and it stores correctly, but no view merges it into the spine, so it never
reaches a screen. Finishing it is a 14th argument across 93 call sites.

**This is no longer waiting on anybody.** FWD's media plan was checked directly: statics only across
all six cycles, video is advisory-only with no production, the buy type is clicks, and every kill,
graduate and scale trigger is click-based. The media grid is already the four columns the app has.
**FWD does not trigger this work**, so it stays deferred by decision rather than by drift.

---

## 5 · Microsoft Clarity — BUILT, NEVER FED. DO NOT FAKE A SCREENSHOT.

The import, the scroll curve, the Lead Gen % comparison and the heatmap upload all work. **No
Clarity export has ever been loaded.** There is one test curve on `0526-03` with no page and no
heatmap; photographing it would be evidence of nothing.

**To make it real, in order:**

1. Clarity → **Heatmaps** → the landing page.
2. Date range = **one round's dates**. `0526-03` is **23–27 May 2026**. The round is matched from
   this range, so a sloppy range files the curve against the wrong round.
3. Set the **device** filter — Mobile or Desktop.
4. Metric: **Scroll**. A Clicks export is refused by name.
5. Export the CSV and **do not open or re-save it** — Excel rewrites the date line.
6. **Keep the device in the filename.** Clarity puts it nowhere else in the file; a file that does
   not say records as "all devices", and the import warns you.

**Import:** Import tab → panel 5 **Landing page scroll** → drop → read the diff → Commit.
**Capture the diff before committing** — it names the round it matched and the window.

**Then** `?client=shely&view=analysis` with `0526-03` selected, step 3.

**Capture** the curve. It proves it if you can see the **vertical mark on each bar** — that is the
round's Lead Gen % on the same axis — and one of the readings above the table. The strongest is
*"the opt-in form cannot sit below N% of the page"*, which is a constraint the two independent
sources produce together, not a restatement of either.

**Heatmap:** Clarity has no heatmap export and its share links expire, so this is a screenshot.
Take one, click **Attach Clarity heatmap** beside the curve, capture the link that appears.

**Worth proving if there is time:** import a **second** landing page for the same round, device and
dates. Both curves must survive, each tagged with its own URL. Until 9 September the second import
silently deleted the first.

---

## 6 · Round Naming Separation — READY

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

The undo is at the bottom of `_build/28`.

---

## 7 · Personalisation — READY

**Go to** `?client=shely&view=round`, click **AUDIENCE → Cold_Broad**.

**Capture two shots:** the round tab filtered, then **switch to another tab** with the filter still
set.

**It proves it** if the filter **follows you across tabs** and the journey strip narrows with it:

```
all audiences         spend 20,474.78 · leads 1,889 · rev 83,927
Cold_Broad            spend  3,373.84 · leads   230 · rev  6,667
Cold_BusinessOwners   spend  3,679.49 · leads   252 · rev  4,173
```

Note this deliberately **reverses** the older "an asset does not follow you to another tab" rule.
Filters follow; drill-downs stay local.

---

## 8 · Cross-round exposure — READY, BUT ONLY IN SQL

Nothing was built, correctly: a person registering for two rounds already writes two rows. There is
**no screen showing one person's history**, so the only honest proof is the query.

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
rows**, one of them in three. Each is counted in the round they registered for and in no other.

---

## 9 · Drop is_lead — READY

**Capture three failures**, which is what proof of a removal looks like:

```sql
select is_lead        from events limit 1;   -- ERROR: column does not exist
select country        from events limit 1;   -- ERROR: column does not exist
select close_round_id from events limit 1;   -- ERROR: column does not exist
```

**Then capture the totals on the same screen if you can.** A dropped column that took a number with
it is the only way this could go wrong, and the pair of pictures rules it out.

---

## The country filter — verified working, and worth one shot

It broke and was rebuilt on 9 September. Current behaviour, measured through the app's key at about
one second each:

```
country=MY       1 round   ·    989.53 · 247 leads   0926-01
country=SG      12 rounds  · 19,485.25 · 1,601 leads
country=SG,MY   12 rounds  · 20,474.78 · 1,848 leads
```

989.53 + 19,485.25 = **20,474.78**, exactly the account total.

**MY is one round and that is correct.** There are exactly two MY campaigns in the account, both in
`0926-01`. An earlier note in these files claimed four; that number came from a script counting the
keys of an error object and was never real.

The 41 leads between 1,848 and 1,889 sit on campaigns resolving to no market — `ALL CAMPAIGNS
0526-02`, `{{campaign.name}}` and fourteen others. Counted in the round, not in a country. That is
the rule working.

---

## If somebody asks why a page was slow

Say it before they ask, because it is the one thing that will come up.

**Every screen is 0.15–0.2 seconds once loaded.** The first load of a filter combination reads the
database and can take several seconds; the result is then cached for thirty minutes. The database
floor is about 1.5 seconds for any read, and a page fires several at once.

That floor is the honest open item. **52 campaigns and 3,000 events should not cost 1.5 seconds on
any plan.** It is an instance-size question, not a query-tuning one — seven query fixes on 9
September took the app from failing to working, and the floor barely moved. It should be sized
before FWD lands, not after.

---

## The one rule behind all nine

**A total that does not move is not proof.** Both faults found in review left `20,474.78` intact
while everything underneath was wrong — one because row-level security hid a table's rows from the
app but not from the SQL editor, the other because credit was being re-filed between rounds that
still summed correctly.

So: **check the distribution, not the sum**, and read anything you verify **through the app**, never
through the Supabase SQL editor. The editor connects as a superuser and sees rows the app cannot.
That difference has already produced one false pass — zero mismatches in the editor, 44 out of 46
through the app's key.
