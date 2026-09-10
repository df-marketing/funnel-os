-- WHO IS ALLOWED TO SEE WHICH CLIENT.
--
-- Two small tables and nothing else. This migration changes no behaviour: until
-- FUNNEL_REQUIRE_LOGIN is set in the app's environment, there is still no login
-- and every screen reads exactly as it does today. The tables sit empty and
-- unread.
--
-- That is deliberate. The app is being demonstrated to a supervisor this week,
-- and a login shipped by accident is a locked door with nobody holding a key.
--
-- ── TWO TABLES, ONE JOB EACH ───────────────────────────────────────────────
--
--   app_users     is this person DriveFunnels staff?
--   client_users  which clients may this person read?
--
-- Staff read everything and do not need rows in client_users. A client user
-- gets one row per client they may see — normally exactly one. Keeping the two
-- apart means "make somebody staff" and "give somebody a client" stay separate
-- operations, and neither can be done by accident while doing the other.

begin;

create table if not exists app_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  -- Staff see every client and the three tabs that write or expose internals.
  -- Default false: a new account can see nothing until somebody says otherwise,
  -- which is the safe direction for a table that grants access.
  is_staff   boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists client_users (
  user_id    uuid not null references auth.users (id) on delete cascade,
  client_id  text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

create index if not exists idx_client_users_user on client_users (user_id);

/**
 * A person may read their own grants and nobody else's.
 *
 * This is the one place row-level security is doing real work today, and it has
 * to: the app asks "which clients am I allowed" using the reader's own session,
 * so without this policy the answer would include everybody else's grants.
 *
 * Note these are `to authenticated` rather than `using (true)` — unlike the
 * thirty policies on the reporting tables, which are public by design and stay
 * that way until the read path is switched over.
 */
alter table app_users enable row level security;
drop policy if exists "read own membership" on app_users;
create policy "read own membership" on app_users
  for select to authenticated using (user_id = auth.uid());

alter table client_users enable row level security;
drop policy if exists "read own grants" on client_users;
create policy "read own grants" on client_users
  for select to authenticated using (user_id = auth.uid());

grant select on app_users    to authenticated;
grant select on client_users to authenticated;

commit;

-- ── HOW TO ADD PEOPLE ──────────────────────────────────────────────────────
--
-- Create the account first: Supabase dashboard → Authentication → Users → Add
-- user. Then grant it something here. There is no self-signup, and there should
-- not be — this is a reporting tool for named clients, not a product with a
-- sign-up page.
--
-- Make somebody staff (sees every client, plus Import, Unmatched and AcqOS):
--
--   insert into app_users (user_id, email, is_staff)
--   select id, email, true from auth.users where email = 'you@drivefunnels.com'
--   on conflict (user_id) do update set is_staff = true;
--
-- Give a client's person access to exactly their own client:
--
--   insert into app_users (user_id, email, is_staff)
--   select id, email, false from auth.users where email = 'someone@memiai.com'
--   on conflict (user_id) do nothing;
--
--   insert into client_users (user_id, client_id)
--   select id, 'shely' from auth.users where email = 'someone@memiai.com'
--   on conflict do nothing;
--
-- Take access away — the account survives, the access does not:
--
--   delete from client_users
--    where user_id = (select id from auth.users where email = 'someone@memiai.com');
--
-- ── VERIFY ─────────────────────────────────────────────────────────────────
--
--   select u.email, a.is_staff,
--          coalesce(array_agg(c.client_id) filter (where c.client_id is not null), '{}') as clients
--     from auth.users u
--     left join app_users a    on a.user_id = u.id
--     left join client_users c on c.user_id = u.id
--    group by u.email, a.is_staff
--    order by u.email;
--
-- And confirm nothing else moved, because this migration should not have
-- touched a single figure:
--
--   spend 20,474.78 · leads 1,889 · attendance 682 · revenue 83,927.00
