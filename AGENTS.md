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
