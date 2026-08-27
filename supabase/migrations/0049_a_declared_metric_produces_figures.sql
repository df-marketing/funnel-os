-- ═══════════════════════════════════════════════════════════════════════════
-- A declared metric stops being a name and starts being a number.
--
-- 0048 made the vocabulary a table: a client can DECLARE that it measures
-- appointments. Nothing counted them. This is phases 2 and 3 — a declared
-- metric now produces figures in every period cut, and the journey strip
-- renders it with a conversion rate, without a line of code knowing its name.
--
-- WHERE THE COUNTS ARE MERGED, AND WHY NOT INSIDE fo_metrics.
--
-- The obvious place is fo_metrics, and it is the wrong one. 0020 wrote the
-- reason down: "eleven views depend on it, so its signature cannot change
-- without dropping every one of them." Threading an extra argument through
-- twelve views to add a count is a large, risky edit to the most load-bearing
-- object in the schema, and it would have to be repeated for every future
-- metric — which is the hand-editing this work exists to end.
--
-- So the counts are merged at the READ boundary instead. fo_cut already
-- rewrites the metric object on its way out — 0028 blinds channel-incoherent
-- ratios there — and this uses the same seam. fo_metrics is untouched, the
-- eleven views are untouched, and every existing figure is computed by exactly
-- the code that computed it yesterday.
--
-- WHAT A DECLARED METRIC GETS. Its own count under its metric_key, and
-- `cp_<key>` — the round's spend divided by it. That is CPQL for a client whose
-- appointments stage is declared, derived generically rather than named.
--
-- Conversion rate is NOT put in the object, because a rate needs to know which
-- stage came before, and that is the client's journey rather than a property of
-- the metric. The strip computes it.
--
-- THE STRIP'S CASE EXPRESSION GOES, FOR EVERY STAGE. Its five core rates were
-- only ever stage N ÷ stage N-1 spelled out by hand — ctr is clicks over
-- impressions, leadgen is leads over clicks, and so on down. Checked before
-- replacing them: the generic rule reproduces all five as IDENTICAL TEXT, to
-- the last digit, on both clients.
--
-- Keeping the CASE for core stages was the first attempt and it was wrong in
-- exactly the case this work creates. Give a client an Appointment stage
-- between Leads and Attend class and prevPct still divides attendance by leads,
-- so the strip prints a chain whose fifth link skips the fourth.
--
-- It also fixes a live defect. Northsea runs Targeted views → Ads → Product
-- page → Checkout with no class in it, so prevPct divided by an attendance that
-- does not exist and its Checkout card showed no rate at all. It reads 51.4%
-- now — the number that stage has always had.
--
-- WHICH CUTS. Every cut whose column is a PERIOD: round, month, week, total,
-- baseline, and the strip. Asset cuts — by audience, by creative — are
-- deliberately not extended: crediting an appointment to an ad set means
-- joining through the acquiring lead, which is a different claim from counting
-- one, and inventing it here would put a number under a column that has not
-- earned it. Those cuts return the core six exactly as before.
--
-- Months and weeks bucket declared events by the event's OWN local day, the
-- same rule 0044 and 0045 established. A new metric does not get to be filed
-- differently from an old one.
--
-- Changes one existing figure, deliberately, and no other. Every cut for every
-- client was captured before and after and diffed: the sole difference is
-- Northsea's Checkout rate, null before and 51.3647642679900744 after. Extras
-- are only ever merged for metrics flagged is_core = false, and the seed has
-- none, so nothing else can move.
--
-- ROLLBACK: re-run 0031's v_journey_strip and fo_cut, then
--   drop function if exists fo_merge_stage(jsonb, jsonb, text);
--   drop function if exists fo_add_stage_costs(jsonb, jsonb);
--   drop function if exists fo_stage_extras(text, text);
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Counts for every declared metric, bucketed the way the cut buckets ──────
--
-- Reads v_rounds and v_events, so the product, channel and period filters
-- fo_cut has already set apply here without being passed again — the same
-- session settings every metric view reads.
create or replace function fo_stage_extras(p_view text, p_client text)
returns jsonb
language sql
stable
as $$
  with counted as (
    select
      case p_view
        when 'v_metrics_by_round'  then e.round_id
        when 'v_metrics_baseline'  then e.round_id
        when 'v_metrics_by_month'  then to_char(date_trunc('month', (e.event_date at time zone 'Asia/Singapore')::date), 'YYYY-MM')
        when 'v_metrics_by_week'   then to_char(date_trunc('week',  (e.event_date at time zone 'Asia/Singapore')::date), 'IYYY-"W"IW')
        when 'v_metrics_total'     then 'TOTAL'
        when 'v_journey_strip'     then 'TOTAL'
      end as cut_key,
      jm.metric_key,
      count(*)::bigint as n
    from v_events e
    join v_rounds r on r.round_id = e.round_id
    join journey_metrics jm
      on  jm.source = 'events'
      and jm.is_core = false
      and jm.event_type = e.event_type
      and (jm.product is null or e.product = jm.product)
    where r.client_id = p_client
    group by 1, 2
  ),
  per_key as (
    select cut_key, jsonb_object_agg(metric_key, n) as x
    from counted where cut_key is not null
    group by cut_key
  )
  select coalesce(jsonb_object_agg(cut_key, x), '{}'::jsonb) from per_key;
$$;

-- ── Merge the counts, and derive what each one cost ─────────────────────────
--
-- cp_<key> is spend over the count — cost per appointment, cost per whatever
-- was declared. Absent rather than zero when the cut has no spend or produced
-- none of the thing: a cost per nothing is not free, it is unanswerable.
create or replace function fo_add_stage_costs(m jsonb, x jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(m, '{}'::jsonb)
      || coalesce(x, '{}'::jsonb)
      || coalesce((
           select jsonb_object_agg(
             'cp_' || e.k,
             case
               when (m ->> 'spend') is not null and e.v ~ '^[0-9]+$' and e.v::numeric > 0
               then (m ->> 'spend')::numeric / e.v::numeric
             end)
           from jsonb_each_text(coalesce(x, '{}'::jsonb)) as e(k, v)
         ), '{}'::jsonb);
$$;

-- ── One row, with its declared metrics folded in ────────────────────────────
--
-- Guards the same thing 0031 guarded: a view with no metric object must pass
-- through untouched rather than have jsonb_set turn the whole row into NULL.
create or replace function fo_merge_stage(row_json jsonb, extras jsonb, cut_key text)
returns jsonb
language sql
immutable
as $$
  select case
    when row_json is null or extras is null or cut_key is null then row_json
    when not (row_json ? 'm') or not (extras ? cut_key) then row_json
    else jsonb_set(row_json, '{m}', fo_add_stage_costs(row_json -> 'm', extras -> cut_key))
  end;
$$;

grant execute on function fo_stage_extras(text, text)          to anon, authenticated, service_role;
grant execute on function fo_add_stage_costs(jsonb, jsonb)     to anon, authenticated, service_role;
grant execute on function fo_merge_stage(jsonb, jsonb, text)   to anon, authenticated, service_role;


-- ── The strip renders whatever the journey names ────────────────────────────
--
-- value comes from the metric's own key rather than a six-branch CASE. For the
-- core six that mapping is exactly what the CASE said — journey_metrics seeds
-- it — so every published value is unchanged.
--
-- rate is this stage over the one before it, in the client's journey order, for
-- every stage. See the header: verified identical to the published ratios.
create or replace view v_journey_strip as
with base as (
  select
    j.client_id, j.stage_order, j.stage_name, j.stage_slug, j.stage_rate_label,
    j.stage_metric,
    jm.metric_key,
    fo_add_stage_costs(t.m, fo_stage_extras('v_journey_strip', j.client_id) -> 'TOTAL') as mm
  from v_journey j
  left join v_metrics_total t on t.client_id = j.client_id
  left join journey_metrics jm on jm.metric = j.stage_metric
),
valued as (
  select *,
    -- Guarded cast: a metric object holds numbers, but a stage naming a metric
    -- nobody declared reads null here rather than failing the whole strip.
    case when (mm ->> metric_key) ~ '^-?[0-9]+(\.[0-9]+)?$'
         then (mm ->> metric_key)::numeric end as value_num
  from base
)
select
  client_id, stage_order, stage_name, stage_slug, stage_rate_label,
  (mm ->> metric_key) as value,
  /*
   * This stage over the one before it, in the client's own journey order —
   * for every stage, core or declared.
   *
   * Verified identical to the published ratios before replacing them: ctr,
   * leadgen, attPct, prevPct and midPct all reproduce to the last digit on both
   * clients, because each was only ever stage N ÷ stage N-1 written out by
   * hand. Nothing on any existing screen moves.
   *
   * Two things it fixes that the CASE could not.
   *
   * A stage inserted between two core ones. Give a client an Appointment stage
   * between Leads and Attend class and prevPct still divided attendance by
   * LEADS, so the strip printed a chain whose fifth link skipped the fourth —
   * "27.1% show" sitting under a stage it did not follow from.
   *
   * A journey that does not have the stage a published ratio assumes. Northsea
   * runs Targeted views → Ads → Product page → Checkout with no class in it, so
   * prevPct divided by an attendance that does not exist and its Checkout card
   * showed no rate at all. It reads 51.4% now, which is the number that stage
   * has always had.
   */
  (
    100 * value_num
    / nullif(lag(value_num) over (partition by client_id order by stage_order), 0)
  )::text as rate,
  stage_metric,
  mm as m
from valued
order by client_id, stage_order;

grant select on v_journey_strip to anon, authenticated;


-- ── fo_cut folds declared metrics into whatever it is asked for ─────────────
create or replace function fo_cut(
  p_view    text,
  p_client  text,
  p_product text default null,
  p_channel text default null,
  p_from    date default null,
  p_to      date default null,
  p_offer   text default null
) returns setof jsonb
language plpgsql
stable
as $$
declare
  v_order  text;
  v_where  text := '';
  v_row    text;
  v_sel    text;
  v_key    text;
  v_shared integer;
  v_extras jsonb;
begin
  v_order := case p_view
    when 'v_metrics_by_month'        then 'month_start'
    when 'v_metrics_by_week'         then 'week_start'
    when 'v_metrics_by_round'        then 'start_date'
    when 'v_metrics_by_round_source' then 'start_date, ord'
    when 'v_metrics_by_offer'        then 'start_date'
    when 'v_metrics_by_source'       then 'ord'
    when 'v_metrics_by_adset'        then 'ord'
    when 'v_metrics_by_ad'           then 'ord'
    when 'v_metrics_by_session'      then 'ord'
    when 'v_metrics_this_round'      then 'ord'
    when 'v_metrics_total'           then 'cut_key'
    when 'v_metrics_baseline'        then 'cut_key'
    when 'v_journey_strip'           then 'stage_order'
    else null
  end;

  if v_order is null then
    raise exception 'fo_cut: % is not a readable cut', p_view;
  end if;

  perform set_config('funnel.product', coalesce(p_product, ''), true);
  perform set_config('funnel.channel', coalesce(p_channel, ''), true);
  perform set_config('funnel.from',    coalesce(p_from::text, ''), true);
  perform set_config('funnel.to',      coalesce(p_to::text,   ''), true);

  v_row := 'to_jsonb(t)';

  -- Did selecting this channel actually take spend away? Counted with the
  -- channel setting momentarily cleared, and put straight back.
  if p_channel is not null then
    perform set_config('funnel.channel', '', true);
    select count(distinct coalesce(channel, 'other'))
      into v_shared
      from v_ads
     where client_id = p_client
       and coalesce(spend, 0) <> 0;
    perform set_config('funnel.channel', p_channel, true);

    if coalesce(v_shared, 0) > 1 then
      -- `? 'm'` guards a view that has no metric object: jsonb_set returns NULL
      -- when handed one, which would drop every row without raising anything.
      v_row := 'case when to_jsonb(t) ? ''m'''
            || ' then jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m''))'
            || ' else to_jsonb(t) end';
    end if;
  end if;

  /*
   * Declared metrics, folded in after the blinding rather than before.
   *
   * Order matters and this is the safe way round: fo_channel_blind nulls the
   * ratios a channel filter cannot answer, and it knows the core keys. Merging
   * first would hand it an object holding keys it has never seen.
   *
   * The strip is keyed on TOTAL because it is always the whole filtered window
   * — it has no cut_key column to read, and asking for one would fail.
   */
  v_extras := fo_stage_extras(p_view, p_client);
  if v_extras <> '{}'::jsonb then
    v_key := case when p_view = 'v_journey_strip' then '''TOTAL''' else 't.cut_key' end;
    v_row := 'fo_merge_stage(' || v_row || ', $3, ' || v_key || ')';
  end if;
  v_sel := 'select ' || v_row;

  if p_view = 'v_metrics_by_offer' and p_offer is not null then
    v_where := ' and product = $2';
    return query execute
      format('%s from %I t where client_id = $1%s order by %s', v_sel, p_view, v_where, v_order)
      using p_client, p_offer, v_extras;
  else
    return query execute
      format('%s from %I t where client_id = $1 order by %s', v_sel, p_view, v_order)
      using p_client, p_offer, v_extras;
  end if;
end;
$$;

grant execute on function fo_cut(text, text, text, text, date, date, text) to anon, authenticated;
