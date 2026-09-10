-- A CURRENCY CHECK SHOULD REFUSE NONSENSE, NOT CURRENCIES.
--
-- Found by trying to onboard a third and fourth client:
--
--   ERROR: 23514: new row for relation "client_flags" violates check
--          constraint "client_flags_currency_check"
--   DETAIL: Failing row contains (zenith_saas, t, null, null, USD).
--
-- The constraint reads:
--
--   check (currency in ('SGD', 'MYR'))
--
-- Which was reasonable when it was written — there were two clients and they
-- used those two currencies. It stops being reasonable the moment somebody
-- signs a client who bills in anything else, because onboarding them then
-- requires a schema migration. A currency column that only accepts the
-- currencies you already have is not a currency column.
--
-- The check was there for a good reason: to stop 'sgd', 'S$', 'dollars' and
-- an empty string reaching a screen. That protection is worth keeping. So the
-- rule becomes the SHAPE of a currency code rather than a list of the ones
-- seen so far — three uppercase letters, which is ISO 4217 and admits USD,
-- EUR, GBP, AUD, IDR, PHP and everything else, while still refusing every
-- spelling mistake the old list refused.
--
-- Nothing about the existing clients changes. SGD and MYR both match, they
-- keep their values, and no figure moves.

begin;

alter table client_flags
  drop constraint if exists client_flags_currency_check;

alter table client_flags
  add constraint client_flags_currency_check
  check (currency ~ '^[A-Z]{3}$');

comment on column client_flags.currency is
  'ISO 4217, three uppercase letters. Checked by shape rather than by a list, '
  'so a new client can be onboarded in any currency without a migration — the '
  'list version refused USD and blocked exactly that.';

commit;

-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
-- The clients that exist are unchanged:
--
--   select client_id, currency from v_clients order by client_id;
--     -- shely SGD · northsea_supply MYR
--
-- A real currency is now accepted and a typo still is not. Both of these
-- should behave as the comment says — the first succeeds, the second fails:
--
--   -- succeeds
--   insert into client_flags (client_id, currency) values ('_probe','USD');
--   -- fails, as it should
--   insert into client_flags (client_id, currency) values ('_probe2','usd');
--   -- clean up whichever landed
--   delete from client_flags where client_id like '\_probe%';
--
-- Then re-run 48-two-more-clients.sql, which failed on this and rolled back
-- whole.
