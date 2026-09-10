/**
 * WHO IS READING, AND WHAT THEY MAY SEE.
 *
 * One place, so there is one answer. Every page asks this and nothing else
 * decides access — a second opinion somewhere in a component is how one screen
 * ends up disagreeing with the rest.
 *
 * ── OFF BY DEFAULT ─────────────────────────────────────────────────────────
 *
 * Enforcement is behind FUNNEL_REQUIRE_LOGIN. Unset, this returns "everyone is
 * staff and may see everything", which is exactly how the app behaves today and
 * how it must keep behaving while it is being demonstrated. A login shipped by
 * accident is a locked door with nobody holding a key.
 *
 * Set it to 1 and the same code starts refusing. Nothing else changes shape.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * This is authorisation in the app, and it is the thing the user actually hits.
 * It is NOT the last line of defence: that is row-level security plus
 * `security_invoker` on the 57 reporting views, which is a separate and larger
 * piece of work. Until that lands, this layer is the only thing between one
 * client and another's figures, so it is deliberately small enough to read in
 * one sitting.
 */

import { createClient } from "@/lib/supabase/server";

export type Access = {
  /** Whether login is being enforced at all. False today. */
  enforced: boolean;
  userId: string | null;
  email: string | null;
  /** Staff read every client, and get Import, Unmatched and AcqOS. */
  staff: boolean;
  /**
   * The clients this person may read. `null` means "no restriction" — staff, or
   * enforcement switched off. An EMPTY ARRAY means an account that exists and
   * has been granted nothing, which is a real state and must not be confused
   * with the unrestricted one. That difference is why this is not `string[]`.
   */
  clientIds: string[] | null;
};

/** Unrestricted: what every reader gets while enforcement is off. */
const OPEN: Access = {
  enforced: false, userId: null, email: null, staff: true, clientIds: null,
};

export const loginRequired = () => process.env.FUNNEL_REQUIRE_LOGIN === "1";

export async function getAccess(): Promise<Access> {
  if (!loginRequired()) return OPEN;

  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) {
    // Enforced and nobody signed in. The middleware normally redirects before a
    // page renders; this is the belt to that pair of braces, and it grants
    // nothing rather than falling back to open.
    return { enforced: true, userId: null, email: null, staff: false, clientIds: [] };
  }

  const [{ data: membership }, { data: grants }] = await Promise.all([
    db.from("app_users").select("is_staff").eq("user_id", user.id).maybeSingle(),
    db.from("client_users").select("client_id").eq("user_id", user.id),
  ]);

  const staff = membership?.is_staff === true;

  return {
    enforced: true,
    userId: user.id,
    email: user.email ?? null,
    staff,
    clientIds: staff ? null : (grants ?? []).map((g) => g.client_id as string),
  };
}

/** May this person read this client at all? */
export function mayRead(access: Access, clientId: string): boolean {
  if (access.clientIds === null) return true;
  return access.clientIds.includes(clientId);
}

/**
 * May this person reach the tabs that write or show internals?
 *
 * Import writes to the database. Unmatched is the reconciliation queue, with
 * other people's names and money in it. AcqOS is the parent system's wiring,
 * which is precisely what clients are not being given. None of the three is a
 * reporting screen and none should be reachable by a client, hidden link or
 * typed URL.
 */
export const STAFF_ONLY_VIEWS = new Set(["import", "unmatched", "acqos"]);

export function mayUseStaffView(access: Access, view: string): boolean {
  return !STAFF_ONLY_VIEWS.has(view) || access.staff;
}

/** The client list this person is allowed to be shown, in the given order. */
export function visibleClients<T extends { client_id: string }>(
  access: Access, clients: T[],
): T[] {
  if (access.clientIds === null) return clients;
  const allowed = new Set(access.clientIds);
  return clients.filter((c) => allowed.has(c.client_id));
}
