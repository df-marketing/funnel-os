-- ═══════════════════════════════════════════════════════════════════════════
-- 0080 — a frozen report says how credit was assigned.
--
-- Attribution is about to let a reader choose where a sale receives credit.
-- A frozen period therefore needs two pieces of context before live views
-- change: the chosen model and an exact fingerprint of the client rules that
-- were in force. Otherwise a versioned report keeps its numbers but cannot
-- explain why they were those numbers.
--
-- This migration deliberately does not alter v_events or any metric view.
-- Its only live effect is that future freezes use the current Entry model and
-- store the current definition fingerprint. Existing freezes truthfully say
-- their rules were not recorded rather than pretending a later rule set made
-- them.
--
-- ROLLBACK: remove the two columns and restore 0041's six-argument function.
-- That loses attribution context from freezes made after this migration.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table period_insights
  add column if not exists attribution_model text,
  add column if not exists rule_version text;

-- Do not backfill a claim we cannot prove. These reports pre-date attribution
-- context, so "unrecorded" is deliberately different from Entry.
update period_insights
set attribution_model = 'unrecorded'
where attribution_model is null;

update period_insights
set rule_version = 'unrecorded'
where rule_version is null;

alter table period_insights
  alter column attribution_model set default 'entry',
  alter column attribution_model set not null,
  alter column rule_version set not null;

alter table period_insights
  drop constraint if exists period_insights_attribution_model_check;

alter table period_insights
  add constraint period_insights_attribution_model_check
  check (attribution_model in ('entry', 'entry_paid', 'last_touch', 'last_paid', 'even_split', 'unrecorded'));

-- A rules version is the canonical content of this client's dimension rows.
-- This is intentionally a fingerprint, not a clock: inserting an unrelated
-- client's rule cannot make Shely's frozen report claim it used new rules.
create or replace function fo_rule_version(p_client_id text)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select md5(coalesce(string_agg(
    jsonb_build_object(
      'target', v.target,
      'key',    v.key,
      'label',  v.label,
      'ord',    v.ord,
      'flags',  v.flags,
      'rules',  v.rules
    )::text,
    '|' order by v.target, v.ord, v.key
  ), ''))
  from dimension_values v
  where v.client_id = p_client_id;
$$;

revoke all on function fo_rule_version(text) from public, anon, authenticated;
grant execute on function fo_rule_version(text) to service_role;

-- The old function has a different identity (six parameters). Dropping it
-- first prevents Postgres from retaining an overload that silently bypasses
-- the new defaults when API routes call it with their existing six arguments.
drop function if exists freeze_period_insight(text, text, text, jsonb, text, text);

create function freeze_period_insight(
  p_client_id text,
  p_period_kind text,
  p_period_key text,
  p_payload jsonb,
  p_frozen_by text default null,
  p_note text default null,
  p_attribution_model text default 'entry',
  p_rule_version text default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_next integer;
  v_prior integer;
  v_model text := coalesce(nullif(p_attribution_model, ''), 'entry');
  v_rule_version text := coalesce(nullif(p_rule_version, ''), fo_rule_version(p_client_id));
begin
  if v_model not in ('entry', 'entry_paid', 'last_touch', 'last_paid', 'even_split') then
    raise exception 'freeze_period_insight: unknown attribution model %', v_model;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_client_id || ':' || p_period_kind || ':' || p_period_key));

  select max(version) into v_prior
  from period_insights
  where client_id = p_client_id and period_kind = p_period_kind and period_key = p_period_key;
  v_next := coalesce(v_prior, 0) + 1;

  update period_insights set is_current = false
  where client_id = p_client_id and period_kind = p_period_kind and period_key = p_period_key and is_current;

  insert into period_insights (
    client_id, period_kind, period_key, version, is_current, payload,
    frozen_by, note, attribution_model, rule_version
  ) values (
    p_client_id, p_period_kind, p_period_key, v_next, true, p_payload,
    p_frozen_by, p_note, v_model, v_rule_version
  );

  return jsonb_build_object(
    'version', v_next,
    'isFirst', v_prior is null,
    'supersededVersion', v_prior,
    'attributionModel', v_model,
    'ruleVersion', v_rule_version
  );
end;
$$;

revoke all on function freeze_period_insight(text, text, text, jsonb, text, text, text, text)
  from public, anon, authenticated;
grant execute on function freeze_period_insight(text, text, text, jsonb, text, text, text, text)
  to service_role;

commit;

-- ── CHECK AFTER RUNNING (using the app's service key) ─────────────────────
-- A new forced test freeze returns attributionModel "entry" and a 32-character
-- ruleVersion. Reading that version returns the unchanged payload. Do not use
-- a production period for this check unless creating a new readable version is
-- intended.
