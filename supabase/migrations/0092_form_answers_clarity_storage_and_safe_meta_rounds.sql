-- 0092 — preserve form answers and make Clarity a page-level evidence source.
-- Existing curves remain readable: points are copied into scroll_runs before
-- the old child rows are retired, so re-running this never deletes evidence.

begin;

alter table events add column if not exists answers jsonb not null default '{}'::jsonb;
create index if not exists idx_events_lead_answers on events using gin (answers jsonb_path_ops)
  where event_type = 'lead' and answers <> '{}'::jsonb;

create or replace view v_form_questions as
with answered as (
  select r.client_id, key as question, value #>> '{}' as answer
  from events e
  join rounds r on r.round_id = e.round_id
  cross join lateral jsonb_each(e.answers)
  where e.event_type = 'lead'
)
select client_id, question,
       count(*)::int as leads_answered,
       count(distinct answer)::int as distinct_answers
from answered
group by 1,2
order by client_id, leads_answered desc, question;
grant select on v_form_questions to anon, authenticated;

-- The split is deliberately raw lead evidence: an answer names what the
-- registrant submitted, not an audience inferred later from campaign rules.
-- One row per answer keeps a question usable even when a free-text field has
-- hundreds of values; the UI can show the common values and leave the long
-- tail named rather than silently collapsing it.
create or replace view v_form_answer_split as
select r.client_id, key as question, value #>> '{}' as answer,
       count(*)::int as leads
from events e
join rounds r on r.round_id = e.round_id
cross join lateral jsonb_each(e.answers)
where e.event_type = 'lead'
group by r.client_id, key, value #>> '{}'
order by r.client_id, key, leads desc, answer;
grant select on v_form_answer_split to anon, authenticated;

-- The points belong with their exported run.  Storing the PNG path rather
-- than a blob keeps Postgres reporting reads small and lets Storage cache it.
alter table scroll_runs add column if not exists page_key text;
alter table scroll_runs add column if not exists heatmap_path text;
alter table scroll_runs add column if not exists points jsonb;

update scroll_runs r
set points = coalesce((
  select jsonb_agg(jsonb_build_object(
    'depth', d.depth_pct, 'visitors', d.visitors, 'drop_off_pct', d.drop_off_pct
  ) order by d.depth_pct)
  from scroll_depths d where d.run_id = r.run_id
), '[]'::jsonb)
where r.points is null;

alter table scroll_runs alter column points set default '[]'::jsonb;
alter table scroll_runs alter column points set not null;

-- The bucket is public because this is an unauthenticated internal dashboard
-- and its database metrics are already public to the same app key. Uploads
-- still run only through the service-side importer; browser clients receive a
-- path, not write credentials.
insert into storage.buckets (id, name, public)
values ('clarity-heatmaps', 'clarity-heatmaps', true)
on conflict (id) do update set public = excluded.public;

create or replace view v_scroll_runs as
-- Preserve the established twelve-column layout. New evidence fields append
-- after `points`; inserting page_key at position four would rename page_label.
select r.run_id, r.client_id, r.round_id, r.page_label,
       r.device, r.sessions, r.page_views, r.captured_from, r.captured_to,
       r.source_file, r.imported_at, r.points,
       r.page_key, r.heatmap_path
from scroll_runs r
order by r.round_id, r.sessions desc, r.device;
grant select on v_scroll_runs to anon, authenticated;

-- Keep the legacy narrow view for audit/export compatibility, but make it read
-- the new canonical JSON.  A later release can drop scroll_depths after one
-- full reporting cycle proves no external reader still uses it.
create or replace view v_scroll_curve as
-- This legacy row-level shape stays unchanged. Page identity belongs to the
-- expanded v_scroll_runs view, so saved CSV/audit readers remain valid.
select r.client_id, r.round_id, r.run_id, r.device, r.sessions,
       (p->>'depth')::integer as depth_pct,
       (p->>'visitors')::integer as visitors,
       nullif(p->>'drop_off_pct','')::numeric(6,2) as drop_off_pct,
       round(100.0 * (p->>'visitors')::numeric / nullif(r.sessions, 0), 1) as reached_pct
from scroll_runs r
cross join lateral jsonb_array_elements(r.points) p
order by r.round_id, r.device, depth_pct;
grant select on v_scroll_curve to anon, authenticated;

commit;

-- The importer now writes answers on lead rows.  Verify one new lead export:
-- select * from v_form_questions where client_id = 'shely';
-- and one existing Clarity run:
-- select page_key, heatmap_path, jsonb_array_length(points) from v_scroll_runs;
