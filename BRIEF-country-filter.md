# Brief — add a Country filter to Funnel OS

You are adding a fourth filter to an app that already has three. The filter
machinery exists and works. **Your job is to use it, not to invent one.**

Read `supabase/migrations/0023_filters.sql` end to end before writing anything.
It explains why the filter bites where it does, and the reasoning applies
unchanged to country.

---

## The requirement

> Be able to tell the difference in performance across different countries.
> Add a 'Country' filter for Malaysia and Singapore.

## The decision already made — do not relitigate it

**Country is a property of a ROUND, not of a client.**

Evidence: the client's master sheet already splits round `0926-01` into `SG`
(102 leads) and `MY` (242 leads) as sub-columns of Paid Ads. A single round runs
in both countries. Campaign names carry it too — `DF_SG_Preview_Sprint1_0526_02`.

A client-level country would mean cross-client aggregation. Every metric view is
scoped `where client_id = p_client`. That is a different and much larger job and
it is **out of scope**.

---

## How the existing filter works

Three filters — product, channel, period — travel as transaction-local settings
rather than as view arguments, because a view takes no arguments:

- `fo_cut(p_view, p_client, p_product, p_channel, p_from, p_to, p_offer)` is the
  single read path. It calls `set_config('funnel.<name>', value, true)` and reads
  the view **in the same transaction**. The `true` makes the setting die with the
  transaction, so one request cannot leak its filter into another.
- Two predicate functions apply it at row level:
  - `fo_filter_ok(product, channel, round_start, round_end)` — for `v_ads`
  - `fo_filter_people_ok(product, round_start, round_end)` — for `v_events`
- Every metric view reads facts through `v_ads` and `v_events`. **Filter there
  and all of them inherit it with no changes.** There are 29 views. You should
  not be touching 29 views.

`current_setting(..., true)` returns NULL when unset, so unset means unfiltered
and reading a view directly behaves exactly as before.

---

## What to build

### 1. Migration `0053_a_round_runs_in_a_country.sql`

**a. Column.**

```sql
alter table rounds add column if not exists country text;
```

Nullable, and **null must mean "not stated", never "Singapore"**. This app's
standing rule is that blank is never zero and absent is never a default. A round
with no country is excluded by a country filter and shown unfiltered — it is not
quietly assigned to one.

Store ISO-3166 alpha-2 uppercase: `SG`, `MY`. Add a check constraint that allows
null and two-letter uppercase. Do not hardcode SG and MY as the only legal
values — a third country must not need a migration.

**b. Back-fill.** Derive from the campaign name where it can be read
(`DF_SG_...` → `SG`). Write the back-fill as an `update ... where country is
null`, so re-running it cannot overwrite a value someone set by hand. **Report
how many rounds it could not determine** — do not leave that silent.

**c. Predicates.** Both functions need country. They take positional arguments,
so adding a parameter creates a new signature; the old one must be dropped or it
will linger and be resolved by mistake. Read the country setting the same way
the others are read — inside the `with f as (...)` block, `nullif(...)` before
any cast, for the reason the file explains.

**d. `v_ads` and `v_events`.** Both must pass `r.country` to the predicate, and
both must expose it as a column so the filter bar can list what actually exists.

> **`create or replace view` may only APPEND columns, never insert or reorder.**
> `country` goes **last** in both. Getting this wrong makes the migration fail
> or, worse, silently shift every downstream column.

**e. `fo_cut`.** Add `p_country text default null` — **last in the parameter
list**, so existing positional callers keep working. Set and clear it exactly as
the others are.

Then the part that is easy to miss: `fo_cut` already has a rule that blanks
channel-derived ratios when the channel filter actually removed something, so a
ratio is never shown against a denominator the filter destroyed. **Country needs
the same treatment.** Follow what `v_shared` does for channel.

### 2. App

- `FilterKey` in `lib/funnel/data.ts` gains `country`.
- The read path passes it through to `fo_cut`.
- `href()` in `components/Shell.tsx` carries it on **every** link — a filtered
  screen must survive a tab change and be pasteable to someone else.
- Filter bar gains a Country control, styled and positioned like Product and
  Channel, listing only the countries present in the data plus `All`.

### 3. Import

`0926-01` proves a single round can be split by country, so a round's country
may be genuinely mixed. **Do not invent a per-row country from a UTM parameter
in this change.** A round-level value is the scope. If a round is mixed, its
country is null and it shows unfiltered — which is honest.

State this on screen rather than in a comment nobody reads.

---

## Constraints — these are not negotiable

1. **Do not run any SQL against the database.** Deliver `.sql` files. The
   developer runs them.
2. **Every migration must be safe to re-run.** `if not exists`, `create or
   replace`, `update ... where country is null`.
3. **Append to `supabase/migrations/ALL.sql` surgically.** Do not rewrite it.
4. **Do not touch the demo client's rounds** (`northsea_supply`, `DEMO-W1`–`W4`).
5. **Never put fixture or test data on `shely`.** It is a real client with real
   reconciled numbers. If you need to test the filter with two countries, use a
   demo client.
6. `npm run lint` is not configured. Use `npx tsc --noEmit` and
   `npm run test:import`.
7. Commit messages: plain sentence, no `feat:` prefix.

---

## Definition of done

- `npx tsc --noEmit` clean.
- `npm run test:import` — currently **449 passing**. Still 449 or more, none
  failing.
- Selecting a country changes spend, leads, attendance and revenue together and
  consistently — the four must not disagree.
- Selecting a country that removes nothing leaves every ratio shown.
- Selecting a country that removes spend blanks the ratios that depended on it
  rather than showing a number against a destroyed denominator.
- With no country selected, **every figure is identical to today**. This is the
  most important check. Verify against these, for client `shely`:

  | | |
  |---|---|
  | Spend | $16,538.10 |
  | Impressions | 318,409 |
  | Leads | 1,349 |
  | Attendance | 583 |
  | Preview purchases | 83 |
  | Preview revenue | $26,251 |
  | Middle purchases | 25 |
  | Middle revenue | $55,691 |
  | Total revenue | $81,942 |
  | ROAS | 2.11 |

  **If any of these move, the filter is wrong.** They were reconciled against
  the client's own master sheet today and are correct.

- A round with a null country is not silently treated as Singapore.

---

## Things that will go wrong if you are careless

- **`null = 'SG'` is NULL, not false.** In SQL that fails the `AND` and deletes
  every row. This exact mistake removed all 313 leads the first time the filter
  was written — it is why there are two predicate functions instead of one with
  a nullable argument. Guard with `is null or =`.
- **The empty string reaching a cast.** SQL does not promise to short-circuit
  `OR`, so `nullif()` must happen before any cast, not beside it.
- **Reordering a view's columns.** Silent, and it corrupts everything downstream.
- **Filtering after aggregation.** You cannot average a ROAS or re-derive a cost
  per lead from six rounds already summed. The filter bites on rows or it is not
  a filter.
