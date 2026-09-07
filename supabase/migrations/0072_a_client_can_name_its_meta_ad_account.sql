-- ═══════════════════════════════════════════════════════════════════════════
-- 0072 — a client can name its Meta ad account.
--
-- "Pull now" has to address an account, and there was nowhere to record which.
-- source_ref on client_journey_config holds FIELD names — 'impressions',
-- 'outbound_click' — and overloading it with an account id would give one column
-- two meanings.
--
-- client_flags is already the per-client settings row, so the account goes here.
-- A column added to a TABLE, not a view: nothing reads client_flags positionally
-- and no view is redefined.
--
-- Null means this client has no Meta pull, which is the default and is not an
-- error — most clients will never have one. The route answers 400 with the
-- reason rather than pretending the account was empty.
--
-- The value is the account id, with or without the act_ prefix; the caller adds
-- it if missing. It is NOT a secret — the token is, and that lives only in
-- META_ACCESS_TOKEN on the deployment, never in the database and never in a row
-- anyone can read.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table client_flags add column if not exists meta_ad_account_id text;

comment on column client_flags.meta_ad_account_id is
  'The Meta ad account this client''s spend is pulled from, e.g. act_1234567890 '
  '(the act_ prefix is optional). Null means no Meta pull is configured, which is '
  'the default. Not a secret: the access token lives in META_ACCESS_TOKEN on the '
  'deployment and never in the database.';

-- client_flags has a row per client only where a flag was needed, and Shely has
-- none yet. Create it rather than making the route handle a missing row as a
-- different case from a missing account — they are the same fact.
insert into client_flags (client_id, is_demo)
select c.client_id, false
from (select distinct client_id from rounds) c
where not exists (select 1 from client_flags f where f.client_id = c.client_id);

commit;

-- ── AFTER RUNNING THIS ─────────────────────────────────────────────────────
-- Record the account id for whichever client is being pulled. Shely's:
--
--     update client_flags
--        set meta_ad_account_id = 'act_XXXXXXXXXXXX'
--      where client_id = 'shely';
--
-- Read it off Ads Manager — it is in the URL as act=… — and paste it in. Until
-- it is set, POST /api/integration/meta-pull answers 400 no_meta_ad_account and
-- writes nothing.
