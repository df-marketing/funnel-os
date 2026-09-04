# funnel-os

<!-- Managed by Launchpad. Edits here may be overwritten on next sync. -->

## Stack & commands

- Framework: Next.js
- `dev`: `next dev --turbopack`
- `build`: `next build`
- `lint`: `next lint`
- `start`: `next start`

## Decisions

- Sprint 3: the import pipeline uses a drop, diff, commit strategy.
- SUPABASE_SECRET_KEY and SUPABASE_SERVICE_ROLE_KEY are both accepted as env vars, providing flexibility in how the service role key is named.
- walkthrough is opened by default on app launch; app remembers when user closes it (via persistent state).
- Bucket instants by the local day, and drop stale plans on commit.
- Absent (null/missing values) is treated as distinct from zero for sales and for spend that has no named audience.
- Stripe integration/dependency was dropped from the project.
- The middle pricing offer was removed (no longer displayed/priced).
- Campaign is included in the ads dedupe key.
- spend per creative is read per creative, and buckets with zero spend are no longer priced.
- staleness rule counts the gap between the last-committed date and the metric's own observation date, not the days-since-import
- The 'By week' tab was removed — it was just a 'By round' tab with a misleading heading.
- graph was redone as one plot with two axes instead of three stacked panels.
- campaign was added to the ads dedupe key.
- audience and ad tags are read from the tags GoHighLevel actually writes, not from arbitrary/assumed tags.
- The page reads a dimension against 'Lead Gen %' metric.
- a push can open a client, and two stages cannot share a slug.
- missing-key column in import is diagnosed by saying which key is missing, not just marking failure.
- the round-list (circle-selector UI) is left unchanged — not reworked.
- A push (import) keeps the breakdown and the label, not just the price — preserving dimensional context during data ingestion.
- Give the imaginary product its own client (separate client/app for the imaginary product).
- round dates are sent as actual dates (e.g., ISO strings or date objects), not as a sentence or human-readable description.
- Bucket instants by local day, and drop stale plans on commit.
- pinned columns are now actually pinned in the UI
- Closed period can be re-read — fixing a view does not fix a report, so the import pipeline allows re-reading a closed period.
- A month is a calendar month, not the one a round started in.
- A declared metric stops being a name/string and becomes a number — the code now enforces numeric typing for metrics.
- The country filter must not break when applied — it was explicitly called out as something to keep working.
- Middle pricing offer was removed from display/pricing
- Bucket instants by the local day; drop stale plans on commit

## Architecture

- Schema includes 29 metric views built from seed generator (Sprint 1).
- App has a nav shell, journey strip, client switcher, and two wired tabs (Sprint 2).
- A 'by source' tab was wired with a two-level column header structure.
- the import pipeline's staleness check compares the bucket's local date (from commit) against the metric's observation date — not the wall clock
- bucket instants by local day; stale plans are dropped on commit
- ads UI changed from twelve columns to one column
- dry-run stub supports .is() filter matching real pipeline
- the unmatched queue is now two-way
- ads dedupe key includes campaign, not just audience/ad
- phone is treated as identity in sales and attendance (not just membership)
- Filter by product, channel and period — before anything is added up
- A native data integration API was added to the project, providing a programmatic interface for ingesting data.
- The app offers clients the stages they actually count (not a superset), and the country filter is preserved as a working constraint.

## Gotchas

- Client switcher defaults to opening on Shely, not the first alphabetically sorted client.
- No objective is set for the project — milestones may lack a guiding north star.
- timestamp was added to an example (not production logic), fixing a self-referential doc inconsistency
- five import bugs were discovered and fixed by testing against real exports, confirming the value of dry-run/real-export testing.
- The unmatched queue was made two-way, and Accept no longer loses money (fixing a bug where accepting an unmatched item would discard funds).
- The test pack size is measured directly rather than predicted, avoiding prediction inaccuracies.
- the commit message 'Say which file was needed first, instead of letting the counts imply it' is a prose/readability improvement, not a code change that adds durable technical facts
- A discarded import is not treated as an import, and a single column does not represent the whole table — likely a bug fix around partial/stale data.
- Ads tab counts 37 attendees while By round tab counts 40 — likely due to different deduplication or filtering rules between the two views.
- audience and ad are read from tags GoHighLevel actually writes, not from assumed tags
- the staleness pill was put back the way it read, with every number source documented
- phone is treated as an identity field in sales and attendance, not just in membership.
- Never cache a failure — one blocked second was becoming one blocked hour
- previously assumed staleness was measured from import date; corrected to compare the committed observation date vs. the metric's date dimension
- batch re-import no longer queues the same import twice; it replaces the old queued import instead.
- ROAS and CPA count only what the advertising directly produced, not what happened nearby — this is a critical interpretation constraint for ads metrics.
- accepting unmatched items had a bug where it would discard funds — now fixed
- Column pinning is now actually enforced in the UI (previously claimed but not implemented)
- A round outside the filter must not leave an empty column behind — filtering logic needs to handle column cleanup.
- Channel ratios are blanked only when the channel filter actually removes something — if the filter takes nothing, ratios remain shown.
- first real run of the import pipeline revealed four faults, none of which threw an exception — silent data corruption is possible if validation is missing.
- The journey strip was showing unfiltered numbers above filtered tables.
- the channel note explained a rule that often didn't apply — conflicting or misleading documentation was present in the codebase.
- the UI no longer overstates what the data covers — data coverage claims are now accurate.
- the import pipeline refuses a filter it cannot apply rather than silently ignoring it.
- A late push is refused — likely means a push after a certain point in the pipeline is rejected to prevent inconsistency
- a frozen copy must be read before the calculation it is meant to outlive — ordering matters to prevent stale-data bugs
- the app was re-sorting the clients the view had already ordered — double-sorting bug fixed.
- gohighlevel writes tags for audience and ad in a specific way — the import reads from those actual tags, not from assumed or arbitrary tag structures.
- Audience and ad fields are now read from the actual tags GoHighLevel writes, not from assumed/arbitrary tag keys.
- Send the round's dates as dates, not as a sentence — likely a fix to import/export date formatting.
- absent (null/missing) is treated as distinct from zero for sales and for spend that has no named audience.
- The commit 'Count the room we cannot name' was merged — likely a reference to a Voldemort/unnamed metric (e.g., 'we do not speak its name').
- A sale can exist without a lead, and a lead dated after a sale did not create that sale — the join between leads and sales is not one-to-one.
- Client stages shown to the user must reflect only the stages the client actually counts, not all possible stages.
- A headcount survives being counted twice — duplicates in attendance are handled safely.
- Drill-into pattern: instead of adding a new tab, the app drills into one asset at a time.
- Five import bugs found and fixed by testing against real exports
- Unmatched queue made two-way; accept no longer loses money (fix for fund discard bug)
- A link omits this tab's default, not the global one — behavior is scoped to the current tab's default rather than a site-wide default.

## Notes

- diagnostic step added to measure Supabase latency from inside the function – indicates ongoing debugging or profiling of import pipeline performance.
- function was moved closer to the database (likely edge function or co-located query) to reduce latency, fetches only the open tab instead of all tabs, and caches results to minimize repeated work.
- attendance example now carries a timestamp, aligning with its own prior advice
- The walkthrough was moved into the app UI instead of being documented externally.
- The 'How this works' walkthrough panel was reverted (recent commit). The walkthrough was previously opened by default on launch with persistent close state memory.
- a dry run of the import pipeline was added, which runs against real exports without committing changes.
- seeded demo data can now be wiped reversibly (likely a migration or seed reset)
- A Refresh data button was added to force a re-read of data.
- A 'By source' tab was wired, completing the tab wiring alongside the existing 'By metric' tab.
- Both tabs — 'by source' and 'by metric' — are now wired in the app.
- the dry-run stub now supports the .is() filter, matching the real pipeline's filtering capability.
- Columns that claim to be pinned are now actually pinned in the UI.
- Phone is now treated as an identity field in sales and attendance, not just in membership — plus a fixed re-upload.
- audience and ad are read from the tags GoHighLevel actually writes, not from arbitrary/assumed tags
- Unsplit spend has no CTR because it is not an audience — CTR is only meaningful for audience-tagged lines.
- No objective is set for this project — milestones may lack a guiding north star.
- coverage note says 'Say where the coverage runs out, not how long ago the file landed' — a commit message convention or lint rule.
- phone is an identity field in sales and attendance, not just membership
- bucket instants by local day, drop stale plans on commit
- the middle pricing offer was removed from the project
- absent (null/missing) is distinct from zero for sales and un-named-audience spend
- no objective has been set for this project — milestones may lack a guiding north star.
- five import bugs discovered and fixed by testing against real exports
- A client sells more than one thing, and buys traffic in more than one place — foundational domain invariant that the app must support multi-product sales and multi-source ad spend.
- Sprint execution: a round runs however many classes it runs, and weeks don't wait for one.
- ad set names were colliding and have been deduplicated (likely via dedupe key changes).
- plot now fills its pane (layout/rendering fix).
- Handoff for review, and stop step 7 truncating its list in silence.
- One control on the graph, not two that overlap — a UI simplification was made to ensure graph controls don't overlap.
- The objective stops being a label and becomes a lens
- The caveat covers the window it is printed next to, and a late push is refused
- dimension names in the app are being made concrete/real rather than generic placeholders.
- closed period insights (likely the 'by source' or 'by metric' tab data) are kept readable even after underlying data changes — they don't break or disappear.
- After reviewing the commit message 'Call a stage what the journey calls it', no additional durable facts beyond what is already in memory were found — the commit appears to be a naming/cosmetic change.
- A month is reported on the spine its product actually runs — likely a fix aligning the reporting period with the actual product run date rather than some other date.
- The most recent commit only touched the demo client (August round), with no changes to any other part of the project.
- A demo round was added whose assets can actually be ranked — the demo is no longer a placeholder.
- A declared metric gets a file to drop — likely means the import pipeline assigns each metric its own dedicated file for dropping data.
- Appointments tab/feature has been declared and is now shown working (functionally wired, not just described).
- project still has no objective set — milestones lack a guiding north star.
- dash before suffix matching was repaired in a recent commit
- Recent commit message is meaningless ('Draw the count an efficiency is an efficiency of') — no substantive change captured.
- commit: 'An asset moves between rounds' — indicates a data model change where an asset (likely a financial or inventory item) is transferred or reallocated between rounds (e.g., import rounds, commitment rounds).
- A tab drills only when something is drilled into
- A variant is a thing you can compare
- v_events view was given the column that the views read it for (likely a missing column fix).
- variant tab was opened on the reading view (the one 'that means something').
