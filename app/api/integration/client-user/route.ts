import { NextResponse } from "next/server";
import { checkIntegrationKey, MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * POST   /api/integration/client-user   { email, clientId, sourceClientId? }
 * DELETE /api/integration/client-user   { email, clientId }
 *
 * ONBOARD THE PERSON ONCE, IN THE PLACE THEY SIGNED UP.
 *
 * Until now a new client meant creating them twice: once in AcqOS, where they
 * sign up themselves, and again here by hand. This is the second half of
 * removing that — the handle claim reserves the client, this admits the person.
 *
 * ── NO PASSWORD CROSSES THE WIRE ───────────────────────────────────────────
 *
 * AcqOS cannot send one: Supabase hashes it at signup and never holds the
 * plaintext again. So this does not try to copy a password. It creates the
 * account with none and hands back a one-time link, which AcqOS puts in the
 * welcome email it already sends.
 *
 * That is better than copying a password would have been, not a compromise for
 * it. Two systems holding the same password drift the first time anybody
 * changes one, and nothing detects the drift — the older one simply keeps
 * working. There is nothing here to fall out of step.
 *
 * GroundTruth also sends no mail. The link is returned, not delivered: AcqOS
 * already has the client's address and an email template, and one welcome
 * message beats two from systems the client has not heard of.
 *
 * ── ONE LOGIN PER CLIENT, FOR NOW ──────────────────────────────────────────
 *
 * Decided rather than assumed: today one person per client needs access, which
 * is also all AcqOS can express — `clients.portal_user_id` is a single column.
 * Nothing here forbids a second person; `client_users` is a join table and will
 * take another row the day AcqOS can name one.
 */

const CLIENT_ID = /^[a-z0-9_-]+$/;
/* Deliberately loose. Rejecting odd-but-real addresses at an integration
   boundary fails a signup for a shape somebody's mail server is perfectly
   happy with, and the address came from AcqOS's own signup form. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function guard(request: Request) {
  const key = checkIntegrationKey(request);
  if (key === "unconfigured") {
    return { error: NextResponse.json({ ok: false, error: MISSING_INTEGRATION_KEY_MESSAGE }, { status: 503 }) };
  }
  if (key !== "ok") {
    return { error: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }
  const db = createAdminClient();
  if (!db) {
    return { error: NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 }) };
  }
  return { db };
}

/** The auth user for this address, or null. Paged because listUsers is paged. */
async function findUser(db: NonNullable<ReturnType<typeof createAdminClient>>, email: string) {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === wanted);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

export async function POST(request: Request) {
  const g = await guard(request);
  if (g.error) return g.error;
  const db = g.db;

  let body: { email?: unknown; clientId?: unknown; sourceClientId?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const sourceClientId = typeof body.sourceClientId === "string" ? body.sourceClientId.trim() : "";

  if (!EMAIL.test(email)) {
    return NextResponse.json({ ok: false, error: "email is required" }, { status: 400 });
  }
  if (!CLIENT_ID.test(clientId)) {
    return NextResponse.json({ ok: false, error: "clientId must be lowercase letters, numbers, underscores or hyphens" }, { status: 400 });
  }

  /* The client has to exist before anybody is admitted to it. Claimed counts —
     a handle reserved at signup is the normal case here, since the funnel does
     not arrive until the Growth Journey is filled in. Granting access to a
     handle nobody holds would create an account that can see nothing and no
     record of why. */
  const { data: flags, error: flagError } = await db
    .from("client_flags").select("client_id, source_client_id").eq("client_id", clientId).maybeSingle();
  if (flagError) return NextResponse.json({ ok: false, error: flagError.message }, { status: 500 });

  const { count: stageCount } = await db
    .from("client_journey_config").select("client_id", { count: "exact", head: true }).eq("client_id", clientId);

  if (!flags && !stageCount) {
    return NextResponse.json({
      ok: false,
      code: "handle_not_claimed",
      error: `no client '${clientId}' here`,
      hint: "claim the handle at /api/integration/client-handle first",
    }, { status: 404 });
  }

  // Same rule as the funnel push: verified when offered, never established here.
  if (sourceClientId && flags?.source_client_id && flags.source_client_id !== sourceClientId) {
    return NextResponse.json({
      ok: false,
      code: "handle_mismatch",
      error: `handle '${clientId}' is claimed by a different AcqOS client`,
      retry: "mint a different handle, claim it, then call this again",
    }, { status: 409 });
  }

  let user;
  try { user = await findUser(db, email); }
  catch (e) { return NextResponse.json({ ok: false, error: String(e) }, { status: 500 }); }

  const existed = Boolean(user);
  if (!user) {
    /* email_confirm because AcqOS already confirmed this address at its own
       signup — making the client prove it twice is a step that teaches them
       the two systems are not really one. */
    const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
    if (error) return NextResponse.json({ ok: false, error: `could not create user: ${error.message}` }, { status: 500 });
    user = data.user;
  }

  const { error: memberError } = await db.from("app_users")
    .upsert({ user_id: user!.id, email, is_staff: false }, { onConflict: "user_id" });
  if (memberError) return NextResponse.json({ ok: false, error: memberError.message }, { status: 500 });

  const { error: grantError } = await db.from("client_users")
    .upsert({ user_id: user!.id, client_id: clientId }, { onConflict: "user_id,client_id" });
  if (grantError) return NextResponse.json({ ok: false, error: grantError.message }, { status: 500 });

  /* The way in, handed back rather than sent. Magiclink rather than invite so a
     re-run for somebody who already has access returns a usable link instead of
     failing on "user already registered" — this endpoint has to be safe to call
     twice, and a retry that cannot produce a link is not. */
  const site = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  const { data: link, error: linkError } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${site}/auth/callback` },
  });

  return NextResponse.json({
    ok: true,
    clientId,
    email,
    created: !existed,
    // Null rather than a failure: the grant is written and correct, and a link
    // can be reissued. Losing the access over an undeliverable link would be
    // the wrong trade.
    signInLink: linkError ? null : link?.properties?.action_link ?? null,
    linkError: linkError?.message ?? null,
    note: "no password is set. The link signs them in; they can set one afterwards.",
  }, { status: existed ? 200 : 201 });
}

/**
 * Revoke. The account survives and reads nothing — they get the "no client yet"
 * screen rather than a broken login, which is the honest thing to show somebody
 * whose access was withdrawn rather than mistyped.
 *
 * The auth user is deliberately not deleted. AcqOS owns whether the person
 * exists; GroundTruth owns what they may read, and deleting somebody else's
 * user record on their behalf is a decision this endpoint has no business
 * making.
 */
export async function DELETE(request: Request) {
  const g = await guard(request);
  if (g.error) return g.error;
  const db = g.db;

  let body: { email?: unknown; clientId?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!EMAIL.test(email) || !CLIENT_ID.test(clientId)) {
    return NextResponse.json({ ok: false, error: "email and clientId are required" }, { status: 400 });
  }

  let user;
  try { user = await findUser(db, email); }
  catch (e) { return NextResponse.json({ ok: false, error: String(e) }, { status: 500 }); }
  // Nothing to revoke is the desired end state, so it is a success.
  if (!user) return NextResponse.json({ ok: true, revoked: false, reason: "no such user" });

  const { error } = await db.from("client_users")
    .delete().eq("user_id", user.id).eq("client_id", clientId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, revoked: true, email, clientId });
}
