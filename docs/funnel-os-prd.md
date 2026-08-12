# Funnel OS — build PRD (v1, EOD sprint)

## Context
Reporting/attribution dashboard for DriveFunnels client Shely (and Northsea Supply). Full spec is in the attached `FUNNEL OS — SCHEMA & WORKFLOW v8` doc — 7-table hybrid schema, 29 metrics, 4 cross-cutting column groups. A working mockup already exists (Claude artifact) — treat its numbers and layout as the source of truth for "does this look right."

## Stack
- Next.js — match whatever router style (App or Pages) the existing DriveFunnels repos already use, don't introduce a new pattern
- Supabase (Postgres) — company DB already provisioned
- Tailwind CSS
- Deployed via Vercel, versioned on GitHub

## Scope for today (EOD)

**In scope:**
1. Full 7-table schema live in Supabase — migration provided in `funnel_os_schema.sql`
2. Seed script that reproduces the mockup's actual numbers (248,692 impressions on Targeted Views, 39 preview purchases, etc.)
3. SQL views implementing the 29 metrics, with blank-vs-zero and zero-denom rules built into the queries
4. Nav shell present for all 13 tabs, grouped exactly as the real mockup: **Data** (Import, Unmatched) / **Overview** (By month, By round, By source, Round × source) / **Compare** — one tab per journey stage (Targeted views, Ads, Landing page, Attend class, Preview offer, Middle offer) / **Now** (This round)
5. Customer Journey summary strip at the top, one card per stage
6. Client switcher (Shely / Northsea Supply), driven by `client_journey_config`
7. **Fully wired to real Supabase data:** Targeted Views + By Round tabs

**Out of scope today (defer, don't attempt):**
- Real Meta / GHL / Zoom / Stripe API integrations — seed data stands in
- Full Import / Unmatched pipeline UI — a static count/badge is enough for now
- The other 11 tabs beyond the 2 fully wired ones — shell + nav only, can show a "not wired yet" state
- Landing Page tab logic — dimension source is still an open decision (needs Anis), leave as a placeholder

## Data model
Use `funnel_os_schema.sql` as-is. Key business rules — encode these in views/queries, not app logic:
- **Previous Paid Ads** = `lead_round_id ≠ close_round_id AND source = 'Paid Ads'`
- **close_round_id** = most recent attendance event before the sale, same contact
- **Blank vs zero** — cost metrics (spend, CPM, CPC, CPL, CPA, ROAS) return `NULL` when a cut has no `ads_performance` rows — never `0`
- **Zero-denom** — ratio metrics (Attendance %, AOV, ROAS) use `NULLIF(denominator, 0)` so a zero denominator renders `—`, not `0%`

## Acceptance criteria
- Targeted Views and By Round numbers match the mockup screenshot exactly, cut for cut
- `—` renders correctly (not `0`, not blank whitespace) for every blank-vs-zero and zero-denom case
- App deploys clean on Vercel from the GitHub main branch

## Open questions (flag if hit, don't silently guess)
- App Router vs Pages Router — confirm against existing repo convention
- Landing Page dimension source — pending Anis
- Whether "AcqOS too" is the same dashboard pattern applied to a different client, or a separate build entirely — out of scope for this PRD either way
