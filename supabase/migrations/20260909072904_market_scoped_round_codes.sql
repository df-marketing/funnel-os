-- 0096 — market-scoped display codes without renaming live foreign keys.
--
-- round_id remains the opaque primary key: altering it would touch six child
-- relationships on production data, none with ON UPDATE CASCADE.  `code` is
-- what people read; `(client, product, market, code)` is what may repeat.
begin;

alter table rounds
  add column if not exists market text,
  add column if not exists code text;

update rounds set code = round_id where code is null;
update rounds set market = 'SG' where client_id = 'shely' and market is null;

alter table rounds alter column code set not null;
alter table rounds drop constraint if exists rounds_market_code_unique;
alter table rounds add constraint rounds_market_code_unique
  unique (client_id, product_id, market, code);

-- Keep the public function signature so every existing reporting view remains
-- valid, but derive the named month from code.  It is STABLE now because it
-- reads rounds instead of being a pure calculation over its arguments.
create or replace function fo_round_month(p_round_id text, p_start date, p_end date)
returns date
language sql
stable
as $$
  with named as (
    select coalesce((select r.code from rounds r where r.round_id = p_round_id), p_round_id) as code
  ), parts as (
    select nullif(substring(code from '^(\d{2})\d{2}-'), '')::int as mm,
           nullif(substring(code from '^\d{2}(\d{2})-'), '')::int as yy
    from named
  ), candidate as (
    select case when mm between 1 and 12 then make_date(2000 + yy, mm, 1) end as month_start
    from parts
  )
  select case when month_start between date_trunc('month', p_start)::date and date_trunc('month', p_end)::date
              then month_start else date_trunc('month', p_start)::date end
  from candidate;
$$;
grant execute on function fo_round_month(text, date, date) to anon, authenticated;

commit;

-- CHECK AFTER RUNNING (through the app's anon key):
-- select round_id, market, code, fo_round_month(round_id,start_date,end_date)
-- from rounds where client_id='shely' order by start_date;
-- Existing ids stay unchanged; 0826-01 still reads as August and 0926-01 as September.
