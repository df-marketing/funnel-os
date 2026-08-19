# Where every number in Funnel OS comes from

Nothing in the app is typed in. Every figure on screen is either a cell from one
of four uploaded files, a count of rows the app wrote, or arithmetic on those
two. This traces each one back to its source.

There is exactly one exception, and it is named in §6: the selling price.

---

## 1 · The chain

```
CSV file  →  import pipeline  →  two tables  →  fo_metrics()  →  a cell on screen
```

Only two tables hold numbers:

| table | holds | written by |
|---|---|---|
| `ads_performance` | money and delivery, no person attached | the ads file |
| `events` | one row per person per thing that happened | leads, attendance, sales |

`contacts` holds identity only — email and phone, no figures. `rounds` and
`client_journey_config` are setup, not data.

---

## 2 · What the four files are read for

Column names are matched case-insensitively against this list. Order doesn't
matter, extra columns are ignored and listed back to you, and a **required**
field with no matching column refuses the import rather than writing blanks.

### Ads performance → `ads_performance`

| field | accepted headers | required |
|---|---|---|
| `date` | date · day · reporting starts · reporting_start | **yes** |
| `spend` | spend · amount spent · amount spent (sgd) · cost | **yes** |
| `campaign` | campaign · campaign name | no |
| `ad_set` | ad set name · adset · ad set | no |
| `ad` | ad · ad name | no |
| `impressions` | impressions · impr · impression | no |
| `reach` | reach · people reached | no |
| `clicks` | clicks · outbound clicks · link clicks · clicks (all) | no |

### Leads → `events` (`event_type = 'lead'`)

| field | accepted headers | required |
|---|---|---|
| `email` | email · email address · contact email | **yes** |
| `event_date` | event_date · created · created at · date created · opt-in date · date | **yes** |
| `phone` | phone · phone number · mobile | no |
| `source` | source · lead source · channel | no |
| `ad_set` | **utm_term** · ad set name · adset · audience · utm_campaign | no |
| `ad` | **utm_content** · ad name · creative | no |
| `utm_campaign` | utm campaign · campaign | no |

`utm_term` holds the audience and `utm_content` holds the creative — those are
the names GoHighLevel actually writes. `utm_campaign` is last in the `ad_set`
alias list on purpose, so files hand-edited before that was understood still
work.

### Attendance → `events` (`event_type = 'attendance'`)

| field | accepted headers | required |
|---|---|---|
| `round_id` | round_id · session · session id · webinar · round | **yes** |
| `email` | email · email address · attendee email | **yes** |
| `phone` | phone · phone number · mobile · contact number | no |
| `event_date` | event_date · joined at · join time · date | no |
| `minutes_watched` | minutes_watched · minutes · duration · time in session | no |

### Sales → `events` (`event_type = 'sale'`)

| field | accepted headers | required |
|---|---|---|
| `event_date` | event_date · date · created · paid at · charge date | **yes** |
| `email` | email · email address · customer email | **yes** |
| `product` | product · plan · item · offer | **yes** |
| `amount` | amount · total · gross · amount (sgd) | **yes** |
| `phone` | phone · phone number · mobile · contact number | no |
| `refund_amount` | refund_amount · refunded · refund · amount refunded | no |
| `refund_date` | refund_date · refunded at · refund date | no |

A blank cell is **absent**, not zero. The one exception is `spend`: Meta writes
an explicit `0` for a day that spent nothing, so 0 there is a measurement.

---

## 3 · The five fields the app works out for itself

These are not in any file. Every one is stored on the row so an inference can be
told apart from a fact.

**`round_id`** — which round the row belongs to.
- *Ads*: the round whose start/end dates contain the spend date.
- *Attendance*: named explicitly in the file, matched against `round_id`, then
  the session date, then a substring.
- *Leads*: see `lead_round_id` below.

**`lead_round_id`** — which round's spend produced this person.
- If the lead carries an ad set, the round that ad set was **actually running
  in** on the opt-in date, read from `ads_performance`. Stored as
  `attribution_method = 'utm'`.
- Otherwise the round whose window contains the opt-in date; failing that, the
  most recent round already open. Stored as `attribution_method = 'date_window'`
  — a weaker claim, and recorded as one.
- Today: **274 by ad set, 32 by date window.**

**`close_round_id`** — which class closed a sale. The most recent attendance by
that person before the purchase timestamp. If someone attends class A then B and
buys after B, the sale closed at B.

**`source`** — taken from the file's `source` column if present, otherwise
derived: `Paid Ads` if the lead carries an ad set, `Organic` if not.
`Previous Paid Ads` is not stored at all — it is derived at read time as a paid
lead whose closing round differs from the round that produced it.

**`contact_id`** — four passes, in this order, and it stops at the first hit:

1. exact email
2. exact phone
3. same mailbox spelled differently (`meilin.w+2@gmail.com` → `meilin.w@gmail.com`)
4. same phone, different formatting (last 8 digits)

**No name matching, ever.** A leads row with contact detail that matches nobody
creates a new person — a lead *is* the creation of a contact. An attendance or
sales row in the same position is **parked**, because someone who bought without
ever opting in is a fact worth surfacing, not a person worth inventing.

---

## 4 · Which round each thing counts on

This is the single most important rule in the app, and it is deliberate:

| counted on | rows |
|---|---|
| `ads_performance.round_id` | spend, reach, impressions, clicks |
| `events.round_id` | leads, attendance |
| `events.lead_round_id` | purchases and revenue |

Revenue counts on the round whose **spend produced the lead**, not the round
whose class closed it. That is what makes ROAS answer "what did this round's
money earn". Both references are kept, so the closing class's take-up rate still
counts only people who attended it.

---

## 5 · The 29 metrics, exactly as computed

All of it is one SQL function, `fo_metrics()`. Every denominator is wrapped in
`nullif(x, 0)`, so a rate with nothing to divide by renders `—` and never
`#DIV/0!`.

### Counted directly

| row | how |
|---|---|
| Ads Spent | `sum(ads_performance.spend)` |
| Reach | `sum(ads_performance.reach)` |
| Impression | `sum(ads_performance.impressions)` |
| Outbound Clicks | `sum(ads_performance.clicks)` |
| Leads | `count(events where event_type = 'lead')` |
| Overall Attendance | `count(events where event_type = 'attendance')` |
| Preview Offer Purchases | `count(sale where product = 'preview')` |
| Middle Offer Purchases | `count(sale where product = 'middle')` |
| Preview Offer Revenue | `sum(amount − refund_amount)` for preview |
| Middle Offer Revenue | `sum(amount − refund_amount)` for middle |
| Total Revenue | preview revenue + middle revenue |

### Rates

| row | formula |
|---|---|
| Frequency | impressions ÷ reach |
| Outbound CTR % | clicks × 100 ÷ impressions |
| Lead Gen % | leads × 100 ÷ clicks |
| Attendance % | attendance × 100 ÷ leads |
| Preview Offer Purchase % | preview purchases × 100 ÷ attendance |
| Middle Offer Purchase % | middle purchases × 100 ÷ preview purchases |

### Unit economics

| row | formula |
|---|---|
| CPM | spend × 1000 ÷ impressions |
| CPC | spend ÷ clicks |
| CPL | spend ÷ leads |
| CP Attendance | spend ÷ attendance |
| CPA | spend ÷ **preview** purchases |
| Preview Offer AOV | preview revenue ÷ preview purchases |
| Preview ROAS | preview revenue ÷ spend |
| Middle Offer AOV | middle revenue ÷ middle purchases |
| Middle ROAS | middle revenue ÷ spend |
| Overall ROAS | total revenue ÷ spend |

CPA measures cost per *acquired customer* and so divides by preview purchases
only — the middle offer is sold to people already acquired.

---

## 6 · The two rows that are not measured

| row | where it comes from |
|---|---|
| Preview Selling Price | `client_journey_config.unit_price` where `stage_slug = 'preview'` |
| Middle Selling Price | `client_journey_config.unit_price` where `stage_slug = 'middle'` |

**These are the only configured numbers in the app.** They are not read from any
file and not derived from revenue. Shely's preview price is **SGD 297**, set as
a row in the journey config. The middle price is null, because that offer was
removed — which is why Middle Selling Price shows `—`.

Each is shown only where that cut actually has purchases of that product;
otherwise it would look like a claim that something sold.

---

## 7 · Blank versus zero

`fo_metrics` does no `coalesce`. NULL in, NULL out, and SQL arithmetic
propagates NULL, so every rate derived from a missing input blanks itself.

- **Zero** is a measurement: the file was imported and this cut had none.
- **`—`** is an absence: nobody has told the app either way.

The two cases where this bites, both on purpose:

- Revenue reads `—` rather than `0.00` until *some* sale exists for the client.
  Before that, "this round earned nothing" is a statement nobody has evidence
  for, and it is the direction that makes the work look worthless.
- In **Unsplit spend**, delivery metrics are blank. Reach, impressions and
  clicks describe how an *audience* was reached; that column's whole meaning is
  "we cannot say which audience", so they have no subject. Spend is blank there
  too, and for a sharper reason: the rows that land in that bucket are the
  reach-and-clicks correction rows, which carry `spend 0.00` because their spend
  was already counted on the rows above. Printed as `0.00` it read as "this
  bucket was free", and it divided into the leads underneath to produce a
  **CPL of 0.00** — a cost of nothing, on real people.

---

## 8 · Everything else on screen

**Journey strip** (the six cards along the top) — each card reads one metric
from the client Total: Targeted views = impressions, Ads = clicks and CTR,
Landing page = leads and Lead Gen %, Attend class = attendance and Attendance %,
Preview offer = preview purchases and take-up %, Middle offer = the same for
middle. Which metric each card shows is set per client in
`client_journey_config.stage_metric`.

**Header** — one pill per source that is stale or never imported, then the
latest `coverage_end` across all four files formatted as a month, then the
currency. All from `import_batches`.

**Stale** does not mean "imported a while ago". A source is stale when its
`coverage_end` falls before the last round that has already **ended** — that is,
when a finished round exists for which this file says nothing. Time passing is
not evidence of missing data; missing data is. The number on the pill is
`days_behind`, the size of that gap: sales covering to 20 May while rounds run
to 27 May reads **`Sales 7d stale`**. A source flagged stale by hand with no gap
to report shows no number rather than a zero. `days_since` — days since the
import — is a separate fact and appears only as "Last import" on the Import tab.

**Import tab** — "Last import", "Covers" and "Rows" are `imported_at`,
`coverage_start → coverage_end` and `row_count` from the newest **committed**
batch for that source. Discarded and staged batches are excluded.

**Unmatched tab** — one row per parked row in `unmatched_rows`. `revenue_held`
is the `amount` off a sales row that couldn't be tied to a person. Park reasons, each
a different problem with a different fix:

| reason | means |
|---|---|
| `name_only` | the row has neither an email nor a phone |
| `incomplete_row` | a field the app needs is missing — fix the file |
| `unknown_person` | has contact detail, nobody here matches it |
| `bought_without_lead` | a sale from someone with no lead on record |
| `no_matching_round` | the row is fine; no round exists to attach it to |
| `phone_format` | same digits as a known person, formatted differently |
| `same_person_two_addresses` | one human, two email addresses |

**Baseline** — the earliest round that has both spend and revenue. Not
configured; picked by that rule.

---

## 9 · Today's actual numbers, traced

| on screen | comes from |
|---|---|
| Ads Spent 1,294.04 / 1,153.22 | `1-ads.csv` `spend` — **the 56 creative rows only** |
| Impression 28,691 / 22,669 | `1-ads.csv` `impressions` — the same 56 rows |
| Reach 12,672 / 10,131 | `1-ads.csv` `reach` — **the 2 round rows only** |
| Outbound Clicks 455 / 377 | `1-ads.csv` `clicks` — **the 18 ad-set rows only** |
| Leads 171 / 135 | `2-leads.csv`, one event per row that resolved |
| Attendance 21 / 19 | `3-attendance.csv`, the 40 rows whose name resolved to one lead |
| Preview Purchases 2 | `4-sales.csv`, the 2 rows that matched a lead |
| Preview Revenue 594.00 | `4-sales.csv` `amount`, those 2 rows × 297 |
| Preview Selling Price 297.00 | **`client_journey_config`** — configured, not measured |
| 5 creatives on the Ads tab | `1-ads.csv` `ad` (Meta's `Ad name`) |
| 6 audiences on Targeted views | `1-ads.csv` `ad_set` ↔ `2-leads.csv` `utm_term` |
| Unmatched 152 rows · SGD 4,176 | `unmatched_rows` |

### Why the ads file has three tiers

`1-ads.csv` is not one export. It is Meta's May report pulled at **three**
granularities and stacked, because different metrics survive being added and
different ones do not:

| tier | rows | carries | why |
|---|---|---|---|
| creative | 56 | `spend`, `impressions` | both are additive, and this is the finest level Meta names an ad at |
| ad set | 18 | `reach`, `clicks` | reach is only true at the level it was queried; clicks are recovered here |
| round | 2 | `reach` | the only reach figure that is true for a whole round |

The spend and impression columns agree with the ad-set export on **18 of 18 ad
sets**, which is the check that says the creative tier is not a different
number wearing the same name.

Reach is the reason for the whole arrangement. It is deduplicated *people*, so
adding it always overstates: creatives → ad set gives 40,911 against a true
39,476; ad sets → campaign gives 20,665 against 11,380; campaigns → round gives
12,765 against 10,131. Every view therefore reads reach off the coarsest row
present rather than summing (migration 0016), and the creative and ad-set tiers
deliberately leave it empty so there is nothing there to add up.

Clicks are the second oddity. Meta's **Outbound clicks** column comes back
empty on all 72 rows because these are on-Facebook lead forms — nobody clicks
*out*. They are recovered exactly as `leads ÷ Lead Gen %`, which lands on whole
numbers for all 18 ad sets and reproduces the master sheet's 377 for 0526-03.
Ticking **Link clicks** on the next export removes the arithmetic; the importer
already accepts that column.

Two consequences show on the Ads tab, both honest rather than broken:

- Every creative shows spend, impressions and CPL, but **no reach, CTR, CPM or
  CPC** — those need a click or reach figure that does not exist per creative.
- Twelve rows carry a raw **Ad ID** instead of a name, marked *"Ad ID, no name
  in the export"*. GoHighLevel wrote the ID on those leads and none of the
  twelve appears in Meta's export, so there is nothing to translate them with.

---

## 10 · What no number in the app comes from

- Nothing is estimated, modelled or interpolated.
- No row is attributed to a person by name. Zoom display names are resolved to
  an email *in the file* before import, and only where exactly one lead answers
  to that name; the other 129 park.
- No figure is carried over from the master sheet. The sheet was used to check
  the app, never to feed it.
- A row that cannot be resolved is parked, and parked rows are counted nowhere.
  **Every total in the app is short by the queue and never over.**
