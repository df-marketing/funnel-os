/**
 * WHO MAY SEE WHAT.
 *
 * These are the rules that decide whether one client can read another client's
 * revenue, so they get their own file rather than a corner of the import tests.
 *
 * Every failure here is silent in the app: the wrong answer renders a correct-
 * looking screen with somebody else's numbers on it. There is no exception
 * thrown, no empty state, nothing to notice. That is the whole reason for
 * pinning them.
 */
import {
  mayRead, mayUseStaffView, visibleClients, STAFF_ONLY_VIEWS, type Access,
} from "../lib/auth/access";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra}`); }
};
const eq = (name: string, got: unknown, want: unknown) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

const OPEN:   Access = { enforced: false, userId: null, email: null, staff: true,  clientIds: null };
const STAFF:  Access = { enforced: true, userId: "u1", email: "s@df.com", staff: true,  clientIds: null };
const SHELY:  Access = { enforced: true, userId: "u2", email: "a@memi.com", staff: false, clientIds: ["shely"] };
const NOTHING:Access = { enforced: true, userId: "u3", email: "new@x.com", staff: false, clientIds: [] };
const ANON:   Access = { enforced: true, userId: null, email: null, staff: false, clientIds: [] };

const CLIENTS = [{ client_id: "shely" }, { client_id: "northsea_supply" }];

console.log("\nAccess — enforcement off is today's behaviour");
{
  // The whole point of the flag: with it unset nothing changes, so the app can
  // ship this code while it is still being demonstrated without a login.
  ok("open access reads any client", mayRead(OPEN, "shely") && mayRead(OPEN, "northsea_supply"));
  ok("open access reaches the staff tabs", [...STAFF_ONLY_VIEWS].every((v) => mayUseStaffView(OPEN, v)));
  eq("open access sees every client", visibleClients(OPEN, CLIENTS), CLIENTS);
}

console.log("\nAccess — a client user sees one client");
{
  ok("reads the client they hold", mayRead(SHELY, "shely"));
  ok("cannot read another client", !mayRead(SHELY, "northsea_supply"));
  eq("the switcher offers only theirs", visibleClients(SHELY, CLIENTS), [{ client_id: "shely" }]);

  /*
   * Import writes to the database. Unmatched is the reconciliation queue, with
   * other people's names and money in it. AcqOS is the parent system clients
   * are explicitly not being given. Hiding the links is not enough — these are
   * refused on the typed URL, which is what this pins.
   */
  ok("no Import", !mayUseStaffView(SHELY, "import"));
  ok("no Unmatched", !mayUseStaffView(SHELY, "unmatched"));
  ok("no AcqOS", !mayUseStaffView(SHELY, "acqos"));

  // …and everything that is a report stays available, or the gate has taken
  // the product with it.
  for (const v of ["round", "month", "source", "roundsource", "analysis", "forms", "ads", "lp", "targeting"]) {
    ok(`still reads ${v}`, mayUseStaffView(SHELY, v));
  }
}

console.log("\nAccess — staff see everything");
{
  ok("reads any client", mayRead(STAFF, "shely") && mayRead(STAFF, "northsea_supply"));
  ok("reaches every staff tab", [...STAFF_ONLY_VIEWS].every((v) => mayUseStaffView(STAFF, v)));
  eq("the switcher offers all of them", visibleClients(STAFF, CLIENTS), CLIENTS);
}

console.log("\nAccess — granted nothing is not granted everything");
{
  /*
   * THE ONE THAT WOULD HURT.
   *
   * An account that exists and holds no grants has `clientIds: []`, and
   * unrestricted has `clientIds: null`. Both are falsy in the ways people
   * usually test, so `if (!clientIds)` treats a brand-new account as an
   * administrator. That is why Access carries `string[] | null` rather than
   * `string[]`, and why these two cases are asserted next to each other.
   */
  ok("a new account reads nothing", !mayRead(NOTHING, "shely") && !mayRead(NOTHING, "northsea_supply"));
  eq("and is offered no client at all", visibleClients(NOTHING, CLIENTS), []);
  ok("and reaches no staff tab", ![...STAFF_ONLY_VIEWS].some((v) => mayUseStaffView(NOTHING, v)));

  // Enforced with nobody signed in: the middleware normally redirects first,
  // so this is the belt to that pair of braces. It must grant nothing rather
  // than fall back to open.
  ok("no session reads nothing", !mayRead(ANON, "shely"));
  eq("no session is offered nothing", visibleClients(ANON, CLIENTS), []);
}

console.log("\nAccess — the filter is by name, not by position");
{
  // A client id that merely looks like another one must not match. Cheap to
  // assert and the kind of thing a future `startsWith` would quietly break.
  const near: Access = { ...SHELY, clientIds: ["shely"] };
  ok("shely does not admit shely_demo", !mayRead(near, "shely_demo"));
  ok("nor a differently-cased spelling", !mayRead(near, "Shely"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
