-- ═══════════════════════════════════════════════════════════════════════════
-- 0074 — the app can read its own rules.
--
-- 0073 created dimension_values, granted select to anon, and seeded six rows.
-- The SQL editor sees all six. The app sees none:
--
--     select count(*) from dimension_values   →  6   (editor, service role)
--     GET /rest/v1/dimension_values           →  0   (app, anon key)
--
-- Row-level security is on and there is no policy, so the grant is necessary
-- and not sufficient. Every other table in this schema carries the same three
-- lines and this one was written without them.
--
-- ── WHY THIS WAS CAUGHT AND NOT SHIPPED ───────────────────────────────────
-- 0073 deliberately wired nothing. Had v_ads and v_events been switched to
-- fo_resolve in the same migration, every campaign would have resolved to NULL:
-- no market on any row, no landing page on any row, the country filter offering
-- nothing, the landing page tab empty — and the totals at the top of the screen
-- still reading 20,474.78, because a total does not care how its rows are
-- labelled. The screen would have looked broken in the places nobody checks
-- first and correct in the place everybody checks first.
--
-- The rule that saved it: a migration that changes what the app READS must be
-- provably inert before anything is pointed at it.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table dimension_values enable row level security;
drop policy if exists "demo read" on dimension_values;
create policy "demo read" on dimension_values for select using (true);
grant select on dimension_values to anon, authenticated;

commit;

-- ── CHECK AFTER RUNNING ───────────────────────────────────────────────────
-- The app's own key must now see what the editor sees. Run this, then tell me
-- and I will re-run the three comparison queries from 0073 through the app's
-- key rather than through the editor — which is what should have been done the
-- first time.
select target, count(*) from dimension_values where client_id = 'shely' group by 1 order by 1;
--   landing_page | 4
--   market       | 2
