-- ═══════════════════════════════════════════════════════════════════════════
-- A push that left earlier must not overwrite one that arrived later.
--
-- generatedAt and schemaVersion were validated by the route and then thrown
-- away, and nothing compared an incoming push against what was already stored.
-- Two pushes in flight at once, or a retry that outlives the edit it was
-- retrying, and the older funnel wins — silently, because a replace that writes
-- the wrong rows looks exactly like a replace that writes the right ones.
--
-- The guard lives in here, not in the route, because only this transaction sees
-- the stored timestamp and the write together. A route-level check would read,
-- lose the race, and write anyway.
--
-- Equal timestamps are allowed through. A retried push carries the same
-- generatedAt as the attempt it is retrying, and an at-least-once sender that
-- cannot safely replay its own message is worse than no guard at all — the
-- replace is idempotent, so letting it land twice costs nothing.
--
-- The return shape gains `written`, which is false only for a refusal. The
-- route turns that into a 409 and reports both timestamps, so a caller that
-- has genuinely fallen behind can tell that from a server fault.
-- ═══════════════════════════════════════════════════════════════════════════

alter table client_journey_config
  add column if not exists schema_version integer,
  add column if not exists generated_at timestamptz;

drop function if exists replace_client_journey_schema(text, text, jsonb, text);
drop function if exists replace_client_journey_schema(text, text, jsonb, text, integer, timestamptz);

create function replace_client_journey_schema(
  p_client_id text,
  p_client_name text,
  p_stages jsonb,
  p_client_note text default null,
  p_schema_version integer default null,
  p_generated_at timestamptz default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prior_rows integer;
  v_prior_generated timestamptz;
  v_client_note text;
  v_prices jsonb;
  v_kept text[];
begin
  select count(*), min(client_note), max(generated_at)
    into v_prior_rows, v_client_note, v_prior_generated
    from client_journey_config
   where client_id = p_client_id;

  -- Strictly older only: a replay of the same push is not a regression.
  if p_generated_at is not null
     and v_prior_generated is not null
     and p_generated_at < v_prior_generated then
    return jsonb_build_object(
      'written', false,
      'reason', 'stale_push',
      'storedGeneratedAt', v_prior_generated,
      'incomingGeneratedAt', p_generated_at
    );
  end if;

  -- A note in the payload wins; an omitted one keeps what is stored, which for
  -- a client being opened here is nothing.
  v_client_note := coalesce(nullif(btrim(p_client_note), ''), v_client_note);

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
    source_type, source_ref, schema_source, synced_at,
    schema_version, generated_at
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
    now(),
    p_schema_version,
    p_generated_at
  from jsonb_array_elements(p_stages) as stage;

  return jsonb_build_object(
    'written', true,
    'created', v_prior_rows = 0,
    'stagesWritten', jsonb_array_length(p_stages),
    'pricesPreserved', to_jsonb(v_kept)
  );
end;
$$;

revoke all on function replace_client_journey_schema(text, text, jsonb, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function replace_client_journey_schema(text, text, jsonb, text, integer, timestamptz) to service_role;
