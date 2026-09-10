-- MANAGING ACCOUNTS — a runbook, not a migration.
--
-- Nothing here runs on its own. Every block is meant to be copied, edited and
-- run one at a time. It lives with the migrations because this is the file
-- somebody will want at 9pm when a client says they cannot get in.
--
-- ── THE ORDER THAT MATTERS ─────────────────────────────────────────────────
--
--   1. create the account          Supabase → Authentication → Users → Add user
--   2. grant it something          a block below
--   3. check it took               the audit query below
--   4. only then                   set FUNNEL_REQUIRE_LOGIN=1 on Vercel
--
-- Do 4 before 1–3 and everybody is locked out, including whoever is reviewing
-- the app. There is no recovery from inside the app: the fix is to unset the
-- variable and redeploy, or to grant an account here and wait for the deploy.
--
-- ── EMAILS ARE LOWERCASE ───────────────────────────────────────────────────
--
-- Supabase stores them lowercase. `where email = 'Someone@X.com'` matches
-- nothing and the insert reports "Success. No rows returned", which reads
-- exactly like success. Every block below uses lower(email) so the capital
-- cannot bite. That has already cost one debugging session.


-- ═══ 1 · WHO HAS WHAT ══════════════════════════════════════════════════════
-- Run this first, and again after every change. It is the only block that is
-- safe to run without thinking.

select u.email,
       coalesce(a.is_staff, false) as is_staff,
       coalesce(array_agg(c.client_id) filter (where c.client_id is not null), '{}') as clients,
       u.last_sign_in_at
  from auth.users u
  left join app_users    a on a.user_id = u.id
  left join client_users c on c.user_id = u.id
 group by u.email, a.is_staff, u.last_sign_in_at
 order by coalesce(a.is_staff, false) desc, u.email;


-- ═══ 2 · MAKE SOMEBODY STAFF ═══════════════════════════════════════════════
-- Staff read every client and reach Import, Unmatched, AcqOS, Refresh data and
-- every writing endpoint. This is the DriveFunnels account.
--
-- Do this for yourself FIRST, before anything else.

insert into app_users (user_id, email, is_staff)
select id, email, true from auth.users
 where lower(email) = lower('REPLACE@drivefunnels.com')
on conflict (user_id) do update set is_staff = true;


-- ═══ 3 · GIVE A CLIENT'S PERSON THEIR ONE CLIENT ═══════════════════════════
-- Two statements, and both are needed: the first says they are not staff, the
-- second says which client they may read. Run them together.

insert into app_users (user_id, email, is_staff)
select id, email, false from auth.users
 where lower(email) = lower('REPLACE@theirdomain.com')
on conflict (user_id) do update set is_staff = false;

insert into client_users (user_id, client_id)
select id, 'shely' from auth.users
 where lower(email) = lower('REPLACE@theirdomain.com')
on conflict do nothing;


-- ═══ 4 · TAKE ACCESS AWAY ══════════════════════════════════════════════════
-- Somebody left. The account survives and reads nothing — they get the "no
-- client yet" screen rather than an error, and no session is silently kept
-- alive against data they can no longer see.
--
-- Deleting the auth user instead is also fine and cascades both tables. Prefer
-- this while you might want them back.

delete from client_users
 where user_id = (select id from auth.users where lower(email) = lower('REPLACE@theirdomain.com'));

update app_users set is_staff = false
 where user_id = (select id from auth.users where lower(email) = lower('REPLACE@theirdomain.com'));


-- ═══ 5 · BEFORE YOU SET THE FLAG ═══════════════════════════════════════════
-- This must return at least one row, or turning on FUNNEL_REQUIRE_LOGIN locks
-- everybody out of production.

select u.email
  from app_users a join auth.users u on u.id = a.user_id
 where a.is_staff
 order by u.email;

-- If that is empty, go back to block 2. If it lists you, then:
--
--   Vercel → funnel-os → Settings → Environment Variables
--   Add   FUNNEL_REQUIRE_LOGIN = 1   for Production
--   Redeploy
--
-- To undo: delete the variable and redeploy. The app returns to open access
-- immediately and no data is touched either way.
