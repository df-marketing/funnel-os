-- ═══════════════════════════════════════════════════════════════════════════
-- A closed period keeps the reading it had when it was closed.
--
-- Imports, corrections and late sales rightly change the live reporting views.
-- They must not quietly rewrite a report AcqOS already read as the period's
-- result. This table stores the complete API response as it was, versioned:
-- a deliberate re-freeze creates version 2 and leaves version 1 readable.
--
-- ROLLBACK: drop function freeze_period_insight(...) and table period_insights;
-- that permanently removes frozen history.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists period_insights (
  client_id text not null,
  period_kind text not null check (period_kind in ('round', 'month')),
  period_key text not null,
  version integer not null,
  is_current boolean not null default true,
  payload jsonb not null,
  frozen_at timestamptz not null default now(),
  frozen_by text,
  note text,
  primary key (client_id, period_kind, period_key, version)
);

create index if not exists period_insights_current_idx
  on period_insights (client_id, period_kind, period_key, version desc);

alter table period_insights enable row level security;

create or replace function freeze_period_insight(
  p_client_id text,
  p_period_kind text,
  p_period_key text,
  p_payload jsonb,
  p_frozen_by text default null,
  p_note text default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_next integer;
  v_prior integer;
begin
  -- Serialise freezes for one period. Without this, two replace requests could
  -- both choose the same next version and one would fail at the primary key.
  perform pg_advisory_xact_lock(hashtext(p_client_id || ':' || p_period_kind || ':' || p_period_key));

  select max(version) into v_prior
  from period_insights
  where client_id = p_client_id and period_kind = p_period_kind and period_key = p_period_key;
  v_next := coalesce(v_prior, 0) + 1;

  update period_insights set is_current = false
  where client_id = p_client_id and period_kind = p_period_kind and period_key = p_period_key and is_current;

  insert into period_insights (
    client_id, period_kind, period_key, version, is_current, payload, frozen_by, note
  ) values (
    p_client_id, p_period_kind, p_period_key, v_next, true, p_payload, p_frozen_by, p_note
  );

  return jsonb_build_object(
    'version', v_next,
    'isFirst', v_prior is null,
    'supersededVersion', v_prior
  );
end;
$$;

revoke all on function freeze_period_insight(text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function freeze_period_insight(text, text, text, jsonb, text, text) to service_role;
