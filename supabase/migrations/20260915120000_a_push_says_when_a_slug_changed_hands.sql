-- A push says when a slug changed hands.
--
-- THE SMOKE ALARM, NOT THE LOCK.
--
-- 0040 preserves three fields across a wholesale replace by keying on
-- stage_slug. AcqOS assigns slugs BY POSITION, so a funnel edit that moves a
-- stage moves its price onto whatever stage now holds that slug. shely's
-- `preview` carries unit_price 297; insert a stage above position 4 and the
-- attendance stage inherits it while the purchase stage comes back null.
--
-- The push returns written:true either way. pricesPreserved counts how many
-- values were re-applied, never whether they landed on the right stage. That is
-- the whole problem: it is not that it fails, it is that it succeeds.
--
-- THE REAL FIX IS BLOCKED, and this is not it. Keying preservation on a stable
-- identity needs one to exist, and AcqOS has none — stage_index breaks on
-- reorder, stage_key is slugify(label) and breaks on rename. Minting one is a
-- scope decision sitting with a supervisor. See docs/SLUG-IDENTITY-PROPOSAL.md.
--
-- So this makes the failure LOUD instead of silent, which costs one column read
-- and needs nothing from AcqOS. The prior stage_name for every slug is one
-- column away in a table 0040 has already read and not yet deleted.
--
--   the slug stayed, but the stage under it changed
--
-- That is the question, and `slugsMoved` is the answer, in the response, on the
-- day it happens rather than whenever somebody next queries a revenue line.
--
-- WHAT IT CANNOT DO, stated here rather than discovered later:
--
--   * It compares NAMES. A stage genuinely renamed in place reports a move that
--     did not happen. Expect false positives on any rename.
--   * A reorder that happens to keep names aligned with slugs reports nothing.
--     Absence of a warning is not proof of safety.
--   * It does not refuse, block or repair anything. The push still succeeds.
--
-- It is a smoke alarm. It does not make the push safe; it makes a bad push
-- visible. Do not read an empty slugsMoved as a guarantee.
--
-- ADDITIVE. One new key in a jsonb return. No column, no constraint, no
-- behaviour change, nothing refused. A caller ignoring it is exactly as correct
-- as it was before.
--
-- SAFE TO RE-RUN. create or replace over 0040's function, same signature.

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
  -- New. slug → the name that slug had BEFORE this push.
  v_names jsonb;
  v_moved jsonb;
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

  -- NEW: slug → prior name. Read here, with the other three, because after the
  -- delete there is nothing left to compare against.
  select coalesce(jsonb_object_agg(stage_slug, stage_name), '{}'::jsonb)
    into v_names
    from client_journey_config
   where client_id = p_client_id and stage_slug is not null and stage_name is not null;

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

  /* THE ALARM. A slug that survived this push but is now attached to a
     differently-named stage.

     `inherited` is the part that matters. A name change alone means the slugs
     moved; a name change with a non-empty `inherited` means a preserved value
     has just been written onto a stage that is not the one it came from. Both
     are reported, because the first is evidence even when nothing was carried,
     and a caller that only wants the dangerous set filters on `inherited`. */
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'slug', s.slug,
             'order', s.ord,
             'wasName', s.was_name,
             'nowName', s.now_name,
             'inherited', s.inherited
           ) order by s.ord), '[]'::jsonb)
    into v_moved
    from (
      select
        stage->>'slug'                   as slug,
        (stage->>'order')::integer       as ord,
        v_names->>(stage->>'slug')       as was_name,
        stage->>'name'                   as now_name,
        (case when nullif(stage->>'unitPrice', '') is null and v_prices ? (stage->>'slug')
              then jsonb_build_array('unitPrice') else '[]'::jsonb end)
        || (case when nullif(stage->>'compareDimension', '') is null and v_dims ? (stage->>'slug')
              then jsonb_build_array('compareDimension') else '[]'::jsonb end)
        || (case when nullif(stage->>'rateLabel', '') is null and v_rates ? (stage->>'slug')
              then jsonb_build_array('rateLabel') else '[]'::jsonb end)
                                         as inherited
      from jsonb_array_elements(p_stages) as stage
      -- Only slugs that existed before. A brand new slug inherits nothing and
      -- has no prior name to have changed.
      where v_names ? (stage->>'slug')
        -- `is distinct from` rather than <>, so a null on either side compares
        -- rather than swallowing the row.
        and v_names->>(stage->>'slug') is distinct from stage->>'name'
    ) s;

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
    'rateLabelsPreserved', to_jsonb(v_kept_rates),
    -- New. Empty is the normal case and is NOT a guarantee — see the header.
    'slugsMoved', v_moved
  );
end;
$$;

revoke all on function replace_client_journey_schema(text, text, jsonb, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function replace_client_journey_schema(text, text, jsonb, text, integer, timestamptz) to service_role;

-- ── PROOF ──────────────────────────────────────────────────────────────────
-- Against shely, whose stage 5 `preview` is "Paid Workshop Purchase ($297)" and
-- holds unit_price 297. Pushing a funnel where `preview` names the attendance
-- stage instead must report:
--
--   slugsMoved: [{ slug: "preview", order: 5,
--                  wasName: "Paid Workshop Purchase ($297)",
--                  nowName: "Live Webinar Attendance",
--                  inherited: ["unitPrice"] }]
--
-- scripts/test-slugmoved.mts runs exactly that against a throwaway client and
-- rolls it back. Never against shely.
