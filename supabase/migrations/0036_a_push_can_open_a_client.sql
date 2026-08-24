-- ═══════════════════════════════════════════════════════════════════════════
-- A push can open a client, and can say what the client is.
--
-- 0034 and 0035 could only ever replace a funnel that already existed, because
-- the route refuses a client with no rows. There is no clients table in this
-- schema — client_journey_config IS the register, and v_clients is built from
-- it — so a new client had to be inserted by hand in SQL before AcqOS could
-- push anything to it. That is the exact job the integration exists to remove.
--
-- Creation is now allowed, but only when the caller asks for it by name: the
-- route requires createClient: true in the payload before it will write a
-- client that isn't there. A typo in an ordinary update still 404s rather than
-- quietly opening a second client under a misspelt id.
--
-- client_note becomes a parameter for the same reason. It is the subtitle in
-- the client switcher, it was previously carried over from the rows being
-- deleted, and a client created by push had no way to ever get one. Omitting it
-- still preserves what is stored, exactly like unit_price in 0035.
--
-- `created` is returned from in here rather than inferred by the route, so it
-- reports what this transaction actually did.
--
-- The signature gains a parameter, so the old function is dropped. p_client_note
-- defaults to null, which keeps a three-argument call valid.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists replace_client_journey_schema(text, text, jsonb);
drop function if exists replace_client_journey_schema(text, text, jsonb, text);

create function replace_client_journey_schema(
  p_client_id text,
  p_client_name text,
  p_stages jsonb,
  p_client_note text default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prior_rows integer;
  v_client_note text;
  v_prices jsonb;
  v_kept text[];
begin
  select count(*), min(client_note)
    into v_prior_rows, v_client_note
    from client_journey_config
   where client_id = p_client_id;

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
    'pricesPreserved', to_jsonb(v_kept),
    'created', v_prior_rows = 0
  );
end;
$$;

revoke all on function replace_client_journey_schema(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function replace_client_journey_schema(text, text, jsonb, text) to service_role;
