-- ═══════════════════════════════════════════════════════════════════════════
-- A schema push must not silently erase the selling price.
--
-- 0034 replaced every row for a client from the AcqOS payload, so unit_price
-- came entirely from that payload. Shely's preview offer is configured at 297
-- here; AcqOS does not know that number. The first push would have sent
-- unitPrice: null, and fo_metrics — which reads p_preview_price straight out of
-- client_journey_config — would have blanked prevPrice and prevAov with nothing
-- said to anybody.
--
-- 0034 already preserved client_note across the replace. This does the same for
-- the price, keyed on stage_slug so it survives a reorder, and it says which
-- prices it kept rather than keeping them quietly. An explicit price in the
-- payload still wins, and an explicit 0 is a price, not an absence.
--
-- The return type changes from void, so the function is dropped and recreated;
-- that discards its grants, which are restated at the bottom.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists replace_client_journey_schema(text, text, jsonb);

create function replace_client_journey_schema(
  p_client_id text,
  p_client_name text,
  p_stages jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_client_note text;
  v_prices jsonb;
  v_kept text[];
begin
  select min(client_note) into v_client_note
  from client_journey_config
  where client_id = p_client_id;

  -- slug → price, for the stages that have both. Read before the delete.
  select coalesce(jsonb_object_agg(stage_slug, unit_price), '{}'::jsonb)
    into v_prices
    from client_journey_config
   where client_id = p_client_id
     and stage_slug is not null
     and unit_price is not null;

  -- Which incoming stages will be taking a price they did not send.
  select coalesce(array_agg(stage->>'slug' order by (stage->>'order')::integer), '{}')
    into v_kept
    from jsonb_array_elements(p_stages) as stage
   where nullif(stage->>'unitPrice', '') is null
     and v_prices ? (stage->>'slug');

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
    -- nullif('') only strips an absent value; '0' survives it and stays 0.
    coalesce(
      nullif(stage->>'unitPrice', '')::numeric,
      (v_prices->>(stage->>'slug'))::numeric
    ),
    stage->>'sourceType',
    stage->>'sourceRef',
    'acqos',
    now()
  from jsonb_array_elements(p_stages) as stage;

  return jsonb_build_object(
    'stagesWritten', jsonb_array_length(p_stages),
    'pricesPreserved', to_jsonb(v_kept)
  );
end;
$$;

revoke all on function replace_client_journey_schema(text, text, jsonb) from public, anon, authenticated;
grant execute on function replace_client_journey_schema(text, text, jsonb) to service_role;
