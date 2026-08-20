-- ═══════════════════════════════════════════════════════════════════════════
-- 0031 — the journey strip was showing unfiltered numbers above filtered tables.
--
-- Found by reading the deployed page with a product filter set. The URL said
-- Memi AI Workshop, the table said 313 leads, and the strip four inches above it
-- said 393:
--
--     strip    impressions 91,360 · clicks 1,632 · leads 393 · preview 17
--     table    impressions 51,360 · clicks   832 · leads 313 · preview  9
--
-- v_journey_strip is not the problem — it reads v_metrics_total, which is
-- filter-aware. The problem is HOW it was read. Every other number on the page
-- goes through fo_cut, which sets the filter and reads the view inside one
-- transaction. The strip was fetched straight from PostgREST, so the settings
-- fo_cut would have set were never set, and every read got the unfiltered total.
--
-- One read path or none. The view is added to fo_cut's whitelist and the app
-- switches to it.
--
-- ── AND THE RATES HAVE TO BE BLINDED WITH EVERYTHING ELSE ──────────────────
-- 0028 blanks ROAS, CPL and Lead gen % when a channel filter removes spend that
-- the revenue and leads keep. Those blanks are applied to the `m` object on the
-- way out of fo_cut — and the strip carried its own flattened `value` and `rate`
-- columns, which nothing would have blinded. Fixing only the filter would have
-- left the strip showing a channel-incoherent Lead Gen % directly above a table
-- that blanks it.
--
-- So the strip now also carries `m`, and the app derives the card from that —
-- the same object, through the same door, blinded by the same rule. The old
-- flat columns stay because `create or replace view` cannot drop them; nothing
-- reads them.
--
-- ── A VIEW WITHOUT AN `m` COLUMN MUST NOT BE WIPED ─────────────────────────
-- fo_cut's blinding did `jsonb_set(to_jsonb(t), '{m}', …)` unconditionally.
-- jsonb_set returns NULL when its new value is NULL, so pointing fo_cut at any
-- view with no `m` column would have returned a set of NULLs rather than an
-- error — rows silently vanishing instead of failing loudly. Guarded here
-- before a future view finds it the hard way.
--
-- Changes no metric.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── THE STRIP CARRIES THE WHOLE METRIC OBJECT ──────────────────────────────
create or replace view v_journey_strip as
select
  j.client_id, j.stage_order, j.stage_name, j.stage_slug, j.stage_rate_label,
  case j.stage_metric
    when 'impressions'       then (t.m->>'impr')
    when 'clicks'            then (t.m->>'clicks')
    when 'leads'             then (t.m->>'leads')
    when 'attendance'        then (t.m->>'att')
    when 'preview_purchases' then (t.m->>'prevBuy')
    when 'middle_purchases'  then (t.m->>'midBuy')
  end as value,
  case j.stage_metric
    when 'clicks'            then (t.m->>'ctr')
    when 'leads'             then (t.m->>'leadgen')
    when 'attendance'        then (t.m->>'attPct')
    when 'preview_purchases' then (t.m->>'prevPct')
    when 'middle_purchases'  then (t.m->>'midPct')
  end as rate,
  -- appended: which metric this card is for, and the object it comes from
  j.stage_metric,
  t.m
from v_journey j
left join v_metrics_total t on t.client_id = j.client_id
order by j.client_id, j.stage_order;

grant select on v_journey_strip to anon, authenticated;

-- ── ONE WAY IN, AND IT NOW SERVES THE STRIP TOO ────────────────────────────
create or replace function fo_cut(
  p_view    text,
  p_client  text,
  p_product text default null,
  p_channel text default null,
  p_from    date default null,
  p_to      date default null,
  p_offer   text default null      -- v_metrics_by_offer only: 'preview' | 'middle'
) returns setof jsonb
language plpgsql
stable
as $$
declare
  v_order  text;
  v_where  text := '';
  v_sel    text;
  v_shared int;
begin
  v_order := case p_view
    when 'v_metrics_by_month'       then 'month_start'
    when 'v_metrics_by_week'        then 'week_start'
    when 'v_metrics_by_round'       then 'start_date'
    when 'v_metrics_by_round_source' then 'start_date, ord'
    when 'v_metrics_by_offer'       then 'start_date'
    when 'v_metrics_by_source'      then 'ord'
    when 'v_metrics_by_adset'       then 'ord'
    when 'v_metrics_by_ad'          then 'ord'
    when 'v_metrics_by_session'     then 'ord'
    when 'v_metrics_this_round'     then 'ord'
    when 'v_metrics_total'          then 'cut_key'
    when 'v_metrics_baseline'       then 'cut_key'
    when 'v_journey_strip'          then 'stage_order'
    else null
  end;

  if v_order is null then
    raise exception 'fo_cut: % is not a readable cut', p_view;
  end if;

  perform set_config('funnel.product', coalesce(p_product, ''), true);
  perform set_config('funnel.channel', coalesce(p_channel, ''), true);
  perform set_config('funnel.from',    coalesce(p_from::text, ''), true);
  perform set_config('funnel.to',      coalesce(p_to::text,   ''), true);

  -- Did selecting this channel actually take spend away? Counted with the
  -- channel setting momentarily cleared, and put straight back.
  v_sel := 'select to_jsonb(t)';
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
      v_sel := 'select case when to_jsonb(t) ? ''m'''
            || ' then jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m''))'
            || ' else to_jsonb(t) end';
    end if;
  end if;

  if p_view = 'v_metrics_by_offer' and p_offer is not null then
    v_where := ' and product = $2';
    return query execute
      format('%s from %I t where client_id = $1%s order by %s', v_sel, p_view, v_where, v_order)
      using p_client, p_offer;
  else
    return query execute
      format('%s from %I t where client_id = $1 order by %s', v_sel, p_view, v_order)
      using p_client;
  end if;
end;
$$;

grant execute on function fo_cut(text, text, text, text, date, date, text) to anon, authenticated;
