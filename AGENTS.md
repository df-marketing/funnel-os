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

## Architecture

- Schema includes 29 metric views built from seed generator (Sprint 1).
- App has a nav shell, journey strip, client switcher, and two wired tabs (Sprint 2).
- A 'by source' tab was wired with a two-level column header structure.

## Gotchas

- Client switcher defaults to opening on Shely, not the first alphabetically sorted client.
- No objective is set for the project — milestones may lack a guiding north star.
- timestamp was added to an example (not production logic), fixing a self-referential doc inconsistency
- five import bugs were discovered and fixed by testing against real exports, confirming the value of dry-run/real-export testing.
- The unmatched queue was made two-way, and Accept no longer loses money (fixing a bug where accepting an unmatched item would discard funds).

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
