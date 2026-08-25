-- ═══════════════════════════════════════════════════════════════════════════
-- A push does not erase the breakdown or the rate label, for the same reason
-- it does not erase the price.
--
-- 0035 taught this function that a null unitPrice means "I have no opinion",
-- not "set it to nothing", because AcqOS does not know what a client charges.
-- compare_dimension and stage_rate_label are exactly the same kind of field and
-- were missed: they were written straight from the payload with no fallback.
--
--   compare_dimension  which column a stage is broken down by
--                      ('ads_performance.ad_set', 'rounds.session_label')
--   stage_rate_label   what the step-conversion column is called
--                      ('CTR', 'opt-in', 'show', 'take-up')
--
-- Both are Funnel OS's own concepts. AcqOS has no view on either and sends null
-- for both, deliberately — lib/funnel-os/translate.ts says so in as many words:
-- "a wrong guess would overwrite a real one. Null leaves what is stored."
--
-- That was true of the price and false of these two. Shely holds five dimensions
-- and six rate labels; the first real push would have taken all eleven, and the
-- loss is invisible — the funnel still renders, the tabs still open, the
-- breakdown control just quietly has nothing to break down by.
--
-- So: same rule, same mechanism, keyed on stage_slug and read before the delete.
--
-- What this gives up, knowingly and exactly as 0035 gave it up for the price: a
-- push can no longer CLEAR one of these fields by sending null. Clearing is a
-- Funnel OS action and belongs in Funnel OS. Send a non-empty value to change
-- one; sending nothing means you are not talking about it.
--
-- Signature is unchanged, so this is create-or-replace and safe to re-run.
--
-- ROLLBACK: re-run 0038; it is the same function without the two coalesces.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function replace_client_journey_schema(
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
  v_dims jsonb;
  v_rates jsonb;
  v_kept text[];
  v_kept_dims text[];
  v_kept_rates text[];
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

  -- slug → value, for the stages that have one. All read before the delete.
  select coalesce(jsonb_object_agg(stage_slug, unit_price), '{}'::jsonb)
    into v_prices
    from client_journey_config
   where client_id = p_client_id and stage_slug is not null and unit_price is not null;

  select coalesce(jsonb_object_agg(stage_slug, compare_dimension), '{}'::jsonb)
    into v_dims
    from client_journey_config
   where client_id = p_client_id and stage_slug is not null and compare_dimension is not null;

  select coalesce(jsonb_object_agg(stage_slug, stage_rate_label), '{}'::jsonb)
    into v_rates
    from client_journey_config
   where client_id = p_client_id and stage_slug is not null and stage_rate_label is not null;

  -- Which incoming stages will be taking a value they did not send.
  select coalesce(array_agg(stage->>'slug' order by (stage->>'order')::integer), '{}')
    into v_kept
    from jsonb_array_elements(p_stages) as stage
   where nullif(stage->>'unitPrice', '') is null and v_prices ? (stage->>'slug');

  select coalesce(array_agg(stage->>'slug' order by (stage->>'order')::integer), '{}')
    into v_kept_dims
    from jsonb_array_elements(p_stages) as stage
   where nullif(stage->>'compareDimension', '') is null and v_dims ? (stage->>'slug');

  select coalesce(array_agg(stage->>'slug' order by (stage->>'order')::integer), '{}')
    into v_kept_rates
    from jsonb_array_elements(p_stages) as stage
   where nullif(stage->>'rateLabel', '') is null and v_rates ? (stage->>'slug');

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
    coalesce(
      nullif(stage->>'compareDimension', ''),
      v_dims->>(stage->>'slug')
    ),
    p_client_name,
    v_client_note,
    stage->>'slug',
    stage->>'metric',
    coalesce(
      nullif(stage->>'rateLabel', ''),
      v_rates->>(stage->>'slug')
    ),
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
    'pricesPreserved', to_jsonb(v_kept),
    'dimensionsPreserved', to_jsonb(v_kept_dims),
    'rateLabelsPreserved', to_jsonb(v_kept_rates)
  );
end;
$$;

revoke all on function replace_client_journey_schema(text, text, jsonb, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function replace_client_journey_schema(text, text, jsonb, text, integer, timestamptz) to service_role;
