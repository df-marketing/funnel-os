-- ═══════════════════════════════════════════════════════════════════════════
-- A stage's compare_dimension has to name a column that exists.
--
-- The push validated it as `table.column` and no further, so 'ads.audience' or
-- 'events.round' — plausible, wrong, and the kind of thing a generator invents —
-- stored without complaint. compare_dimension is not interpolated into a query
-- (0015 wired one hand-built view per stage slug, and that is what actually
-- cuts), so a wrong value does not fail. It sits in the register saying the
-- stage is cut by something it is not, and nothing ever contradicts it.
--
-- Checked against pg_catalog rather than a list kept in the app, because a list
-- has to be remembered and this cannot drift. to_regclass returns null for a
-- table that isn't there instead of raising, so an unknown table and an unknown
-- column give the same answer by the same path.
--
-- This says a column exists. It does not say the app can cut by it — only the
-- stage slug decides that. Naming a real column is the floor, not the ceiling.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function fo_unknown_dimensions(p_dimensions text[])
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(distinct d), '{}'::text[])
  from unnest(coalesce(p_dimensions, '{}'::text[])) as d
  where d is not null
    and not exists (
      select 1
      from pg_attribute a
      where a.attrelid = to_regclass('public.' || quote_ident(split_part(d, '.', 1)))
        and a.attname  = split_part(d, '.', 2)
        and a.attnum > 0
        and not a.attisdropped
    );
$$;

revoke all on function fo_unknown_dimensions(text[]) from public, anon, authenticated;
grant execute on function fo_unknown_dimensions(text[]) to service_role;
