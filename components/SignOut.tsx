/**
 * Who you are signed in as, and the way out.
 *
 * A plain form posting to /auth/signout rather than a fetch: it works before
 * hydration, and it keeps the sign-out a POST. A GET sign-out is a link anybody
 * can drop in a chat message or an image tag and log somebody out by having
 * them look at it.
 *
 * Renders nothing when there is no session, which is every request while
 * FUNNEL_REQUIRE_LOGIN is unset.
 */
export function SignOut({ email }: { email: string | null }) {
  if (!email) return null;
  return (
    <form action="/auth/signout" method="post" className="signout">
      <span className="meta" title={email}>{email}</span>
      <button className="btn tiny ghost" type="submit">Sign out</button>
    </form>
  );
}
