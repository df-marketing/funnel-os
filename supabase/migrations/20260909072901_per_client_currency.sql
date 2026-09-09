-- 0094 — currency is client metadata, not a hard-coded presentation detail.
--
-- client_journey_config is replaced by AcqOS on every schema push.  Currency
-- must survive that replacement, so it belongs on client_flags alongside the
-- other Funnel OS-owned client facts.  Existing clients retain SGD; a new
-- AcqOS payload may set MYR (the accepted legacy spelling RM is normalised by
-- the API before it reaches this column).
begin;

alter table client_flags
  add column if not exists currency text not null default 'SGD';

alter table client_flags
  drop constraint if exists client_flags_currency_check;
alter table client_flags
  add constraint client_flags_currency_check
  check (currency in ('SGD', 'MYR'));

create or replace view v_clients as
select
  j.client_id,
  min(j.client_name)         as client_name,
  min(j.client_note)         as client_note,
  count(*)                   as stage_count,
  coalesce(r.round_count, 0) as round_count,
  coalesce(f.is_demo, false) as is_demo,
  coalesce(f.currency, 'SGD') as currency
from client_journey_config j
left join (
  select client_id, count(*) as round_count from rounds group by client_id
) r on r.client_id = j.client_id
left join client_flags f on f.client_id = j.client_id
group by j.client_id, r.round_count, f.is_demo, f.currency
order by coalesce(f.is_demo, false), coalesce(r.round_count, 0) desc, j.client_id;

grant select on v_clients to anon, authenticated, service_role;
commit;

-- CHECK AFTER RUNNING (through the app's anon key):
-- select client_id, currency from v_clients order by client_id;
-- Every existing client reads SGD until AcqOS explicitly sends MYR.
