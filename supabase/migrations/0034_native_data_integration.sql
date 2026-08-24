-- Native Data Integration: AcqOS owns the funnel definition; Funnel OS owns actuals.
-- A client must already exist. The route validates the full payload first, and
-- this one function performs its delete-and-replace in one database transaction.

alter table client_journey_config
  add column if not exists source_type text,
  add column if not exists source_ref text,
  add column if not exists schema_source text,
  add column if not exists synced_at timestamptz;

alter table client_journey_config
  drop constraint if exists client_journey_config_source_type_chk;
alter table client_journey_config
  add constraint client_journey_config_source_type_chk
  check (source_type is null or source_type in ('meta', 'google', 'crm', 'csv'));

create or replace function replace_client_journey_schema(
  p_client_id text,
  p_client_name text,
  p_stages jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_client_note text;
begin
  select min(client_note) into v_client_note
  from client_journey_config
  where client_id = p_client_id;

  delete from client_journey_config where client_id = p_client_id;

  insert into client_journey_config (
    client_id, stage_order, stage_name, compare_dimension, client_name, client_note,
    stage_slug, stage_metric, stage_rate_label, unit_price,
    source_type, source_ref, schema_source, synced_at
  )
  select
    p_client_id,
    (stage->>'order')::integer,
    stage->>'name',
    nullif(stage->>'compareDimension', ''),
    p_client_name,
    v_client_note,
    stage->>'slug',
    stage->>'metric',
    nullif(stage->>'rateLabel', ''),
    nullif(stage->>'unitPrice', '')::numeric,
    stage->>'sourceType',
    stage->>'sourceRef',
    'acqos',
    now()
  from jsonb_array_elements(p_stages) as stage;
end;
$$;

revoke all on function replace_client_journey_schema(text, text, jsonb) from public, anon, authenticated;
grant execute on function replace_client_journey_schema(text, text, jsonb) to service_role;
