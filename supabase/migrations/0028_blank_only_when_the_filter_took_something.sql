-- ═══════════════════════════════════════════════════════════════════════════
-- 0028 — blank the channel ratios only when the channel filter removed spend.
--
-- 0027 blanked ROAS, CPA, CPL and Lead gen % whenever ANY channel was selected.
-- The reasoning held — revenue carries no platform, so dividing all of it by
-- one channel's spend credits that channel with the other's results — but the
-- rule was blunter than the reasoning, and it showed the moment it met the real
-- account:
--
--     workshop, no channel    spend 2,447.26 | ROAS 0.364  CPA 815.75  CPL 7.82
--     workshop, channel=meta  spend 2,447.26 | ROAS —      CPA —       CPL —
--
-- Identical spend. The workshop only ever ran on Meta, so filtering to Meta
-- removed nothing, and four correct numbers vanished for no reason. That is its
-- own kind of dishonesty: a blank claims "this cannot be known", and here it
-- could.
--
-- The test is now whether the filter actually took something — more than one
-- channel with spend inside the CURRENT scope, which means product and period
-- count too. Filter the account to May, when only Meta ran, and the ratios come
-- back even though June has Google in it. Ask for all products across all time
-- with Meta selected, and they blank, because Google's spend really was removed
-- while its revenue stayed.
--
-- The count deliberately ignores channels with no spend: a channel that never
-- cost anything cannot have been subtracted.
--
-- fo_channel_blind loses its current_setting() lookup and becomes what its name
-- says — a function that removes four ratios from a metric object. WHETHER to
-- call it is fo_cut's decision, which is where the filter is known. Being
-- genuinely immutable now, rather than immutable-but-reading-a-GUC, is a
-- correctness fix in its own right: the planner was within its rights to fold a
-- call that quietly depended on session state.
--
-- Costs one extra query per read, and only when a channel is selected.
-- Changes nothing when no channel filter is set.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── THE RATIOS THAT CANNOT SURVIVE A CHANNEL SPLIT ─────────────────────────
-- Each one divides something unattributed by something channel-scoped. Nulled
-- rather than dropped, so the spine renders a dash instead of losing the row.
create or replace function fo_channel_blind(m jsonb)
returns jsonb
language sql
immutable
as $$
  select m || jsonb_build_object(
    'roas',     null,   -- all revenue ÷ one channel's spend
    'prevRoas', null,
    'midRoas',  null,
    'cpa',      null,   -- one channel's spend ÷ all buyers
    'cpl',      null,   -- one channel's spend ÷ all leads
    'cpAtt',    null,   -- one channel's spend ÷ all attendees
    'leadgen',  null    -- all leads ÷ one channel's clicks
  );
$$;

grant execute on function fo_channel_blind(jsonb) to anon, authenticated;

-- ── ONE WAY IN ─────────────────────────────────────────────────────────────
-- Unchanged from 0027 except that the blanking is now conditional.
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
  -- channel setting momentarily cleared, so v_ads answers for the whole
  -- product-and-period scope rather than for the one channel already chosen.
  -- Transaction-local, and put straight back.
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
      v_sel := 'select jsonb_set(to_jsonb(t), ''{m}'', fo_channel_blind(to_jsonb(t)->''m''))';
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
