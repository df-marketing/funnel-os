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

## Architecture

- Schema includes 29 metric views built from seed generator (Sprint 1).
- App has a nav shell, journey strip, client switcher, and two wired tabs (Sprint 2).

## Gotchas

- Client switcher defaults to opening on Shely, not the first alphabetically sorted client.
- No objective is set for the project — milestones may lack a guiding north star.
- timestamp was added to an example (not production logic), fixing a self-referential doc inconsistency

## Notes

- diagnostic step added to measure Supabase latency from inside the function – indicates ongoing debugging or profiling of import pipeline performance.
- function was moved closer to the database (likely edge function or co-located query) to reduce latency, fetches only the open tab instead of all tabs, and caches results to minimize repeated work.
- attendance example now carries a timestamp, aligning with its own prior advice
- The walkthrough was moved into the app UI instead of being documented externally.
