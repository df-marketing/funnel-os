# Proving the nine requirements — a screenshot script

**For:** a supervisor review. Every step names what to click, what to capture, and **what the
picture proves** — a screenshot of a screen that would look identical if the feature were broken
proves nothing, and three of these need care for exactly that reason.

Base URL: `https://funnel-os-red.vercel.app`. Client: **Memi AI (Shely)** unless a step says
otherwise.

**The figures every shot must leave alone:**

```
spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00 · ROAS 1.80
```

---

## The order to shoot in

Six are ready now. Two need something imported first. One cannot be finished until FWD answers a
question. Do **1, 2, 3, 7, 8, 9** in one pass, then set up **5** and **6**, and leave **4** last.

---

## 1 · Form answers — READY

**Go to** `?client=shely&view=forms`

**Capture** the whole pane.

**It proves it** if three questions are shown — profession, main challenge, free webinar — each on
**976 leads**, and **"Tags" and "Last Activity" are absent**. Those two were being reported as
questions until 9 September; if either is back, the import regressed.

Say out loud that this covers **976 of 1,889 leads — 52%** and that the top profession answer is
**"Others" at 413**. A supervisor who finds that themselves will discount the whole screen.

---

## 2 · Attribution models — READY

**Go to** `?client=shely&view=round`. The **CREDIT** block is in the left sidebar.

**Capture three shots** of the same tab: **Entry**, **Last touch**, **Even split**.

**It proves it** only if you capture the round rows, not just the header. The total is **83,927 in
all three** — that is the point, and on its own it is also what a broken selector would show. The
proof is that the **per-round revenue moves** while the total does not. `0726-02` is the clearest:

```
entry        23,173
last_touch   13,876
even_split   18,648
```

Credit moves between rounds; it is never created or destroyed.

---

## 3 · Source attribution — READY

**Go to** `?client=shely&view=source`

**Capture** the table.

**It proves it** if five sources appear and **spend sits only on Paid Ads**, with the others
**blank — not `0.00`**. Blank means absent. A zero would be a claim that Organic was advertised
against and returned nothing.

```
Paid Ads 1,520 · Organic 307 · AOAI 61 · Tracking not captured 1 · Unattributed 0   = 1,889
```

**Second shot:** click **SOURCE → Organic** in the sidebar and capture the journey strip. The
numbers at the top must drop with the table. A strip that stays at 1,889 over a filtered table is
the specific bug this app had once.

---

## 4 · Dynamic customer journey — PART-BUILT, DO NOT CLAIM DONE

**What can be shown:** a client's stages are rows, not code. `event_types` holds what a person can
do and `journey_metrics` maps a stage to one, so adding "policy issued" is two rows.

**Capture** `?client=shely&view=acqos` — the declared stages — and the client switcher showing
**Memi AI** and **Northsea Supply** running different journeys.

**What cannot be shown, and say so:** a client can declare a custom *ads* measurement and it will
store, but **no metric view merges it into the spine**, so it never reaches a screen. Finishing that
is a 14th argument across **93 call sites**, deliberately not built.

**The blocking question for FWD:** *does any of your funnel stages measure something Meta reports —
video views, ThruPlays — rather than something a person does?* If no, this stays as it is.

---

## 5 · Microsoft Clarity — NEEDS AN EXPORT FIRST

Nothing has ever been imported. There is one test curve on `0526-03` with no page and no heatmap.
**Do not screenshot that** — it would be evidence of nothing.

**Set it up:**

1. In Clarity, open **Heatmaps** for the landing page.
2. Set the date range to **one round's dates** — e.g. `0526-03` is **23–27 May 2026**. The round is
   found from this range, so a sloppy range files the curve against the wrong round.
3. Set the **device** filter — Mobile or Desktop.
4. Metric: **Scroll**. A Clicks export is refused by name.
5. Export the CSV and **do not open or re-save it**. Excel rewrites the date line.
6. **Keep the device in the filename.** Clarity puts it nowhere else in the file — a file that
   doesn't say records as "all devices", and the import warns you about it.

**Import:** Import tab → panel 5 **Landing page scroll** → drop the file → read the diff → Commit.

**Capture the diff before committing.** It states the round it matched and the window.

**Then go to** `?client=shely&view=analysis` (**This round**) with `0526-03` selected, step 3.

**Capture** the curve. It proves it if you can see the **vertical mark on each bar** — that is the
round's Lead Gen % on the same axis — and one of the four readings above the table. The strongest is
*"the opt-in form cannot sit below N% of the page"*, which is a constraint the two independent
sources produce together, not a restatement of either.

**Heatmap:** Clarity has **no heatmap export** and its share links expire, so this is a screenshot.
Take one of the Clarity heatmap, then click **Attach Clarity heatmap** beside the curve. Capture the
**Open imported Clarity heatmap** link that appears.

**Worth proving if you have time:** import a **second** landing page for the same round, device and
dates. Both curves must survive, each tagged with its own URL. Until 9 September the second import
**deleted** the first.

---

## 6 · Round naming per market — RUN ONE SQL FIRST

Built, and never exercised: every round is SG or unmarked, and **no code is used twice**, so the
constraint has never had to allow anything.

**Run** `_build/28-my-and-sg-both-hold-0526-01.sql`. It creates two rounds sharing code `0526-01`
across MY and SG **on the demo client**, not on Shely.

**Then** switch the client switcher to **Northsea Supply** and capture the **PERIOD** list.

**It proves it** if both appear and the market shows itself:

```
0526-01 (MY) · 4–10 May
0526-01 (SG) · 11–17 May
```

Note that Shely's own list shows **no** market — one market means nothing to disambiguate. The
market appearing exactly when it starts meaning something is the design, not an inconsistency.

The undo is at the bottom of the same file.

**Second claim, worth a shot:** an ambiguous code is **refused, not guessed**. That behaviour is
pinned by tests named in `npm run test:import` — screenshot the passing run if a picture is needed.

---

## 7 · Personalisation — READY

**Go to** `?client=shely&view=round`, then click an audience in **AUDIENCE** — `Cold_Broad` is a
good one.

**Capture two shots:** the round tab filtered, then **switch to another tab** with the filter still
set.

**It proves it** if the filter **follows you across tabs** and the journey strip narrows with it:

```
all audiences   spend 20,474.78 · leads 1,889 · rev 83,927
Cold_Broad      spend  3,373.84 · leads   230 · rev  6,667
```

Note this deliberately **reverses** the older "an asset does not follow you to another tab" rule.
Filters follow; drill-downs stay local.

---

## 8 · Cross-round exposure — READY, BUT ONLY IN SQL

Nothing was built, correctly: a person registering for two rounds already writes two rows. There is
**no screen that shows one person's history**, so the only honest proof is the query.

**Run and capture:**

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
rows**, one of them in three. Each row is counted in the round it registered for and in no other.

---

## 9 · Retired columns — READY

`is_lead`, `country` and `close_round_id` are gone from `events`.

**Capture** three failures, which is what proof of a removal looks like:

```sql
select is_lead from events limit 1;         -- ERROR: column does not exist
select country from events limit 1;         -- ERROR: column does not exist
select close_round_id from events limit 1;  -- ERROR: column does not exist
```

**Then capture the totals again** on the same screen as the errors if you can. A dropped column that
took a number with it is the only way this could go wrong, and the pair of pictures rules it out.

---

## The one rule for all nine

**A total that does not move is not proof.** Both faults found in review left `20,474.78` intact
while everything underneath was wrong — one because row-level security hid a table's rows from the
app but not from the SQL editor, the other because credit was being re-filed between rounds that
still summed correctly.

So: **check the distribution, not the sum**, and read anything you verify **through the app**, not
through the Supabase SQL editor. The editor connects as a superuser and sees rows the app cannot.
That difference has already produced one false pass — zero mismatches in the editor, 44 out of 46
through the app's key.
