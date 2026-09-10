/**
 * WHO MAY CLAIM A HANDLE.
 *
 * The wrong answer here is not an error page. GT's funnel-schema route treats
 * `createClient: true` on an existing client as a successful retry — it
 * REPLACES the funnel — so a claim that wrongly says "yours" hands one client's
 * reporting to another, with no error and a screen that looks entirely correct.
 *
 * The two cases that must never be confused look identical from outside:
 * same handle and same AcqOS client is a retry; same handle and a different
 * one is a collision.
 */
import { decideClaim, type ClaimRow } from "../lib/integration/claim";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
};

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

console.log("\nClaim — a free handle");
{
  eq("nothing on record is a plain claim",
     decideClaim([], "acme", A), { kind: "claim", adopted: false });

  eq("another client's row does not block a different handle",
     decideClaim([{ client_id: "other", source_client_id: B }], "acme", A),
     { kind: "claim", adopted: false });
}

console.log("\nClaim — a retry is not a collision");
{
  /* The pair this file exists for. Both are "the handle is taken"; only one is
     allowed to proceed, and getting it backwards either breaks every retry or
     hands a client's funnel to a stranger. */
  eq("same handle, same client — a retry",
     decideClaim([{ client_id: "acme", source_client_id: A }], "acme", A),
     { kind: "already-yours" });

  eq("same handle, different client — a collision",
     decideClaim([{ client_id: "acme", source_client_id: B }], "acme", A),
     { kind: "handle-taken" });
}

console.log("\nClaim — one client, one handle");
{
  /* Distinct from a taken handle, and the distinction is the fix. Re-minting
     resolves a collision; here it would mint a SECOND handle for a client that
     already has one, which is the drift the unique index prevents. */
  eq("this client already holds another handle",
     decideClaim([{ client_id: "acme_fitness", source_client_id: A }], "acme", A),
     { kind: "source-holds-other", heldHandle: "acme_fitness" });

  eq("and the reply names it, so nobody re-mints in a loop",
     (decideClaim([{ client_id: "zenith", source_client_id: A }], "acme", A) as { heldHandle: string }).heldHandle,
     "zenith");
}

console.log("\nClaim — adopting a handle set by hand");
{
  /*
   * shely's handle predates the wire: somebody wrote it in SQL and it is the
   * live production link. AcqOS should adopt it rather than mint shely_2, so an
   * unowned row is claimable — and the reply says `adopted` so the caller knows
   * it inherited something rather than creating it.
   */
  eq("an unowned row is adopted, not refused",
     decideClaim([{ client_id: "shely", source_client_id: null }], "shely", A),
     { kind: "claim", adopted: true });

  eq("but an owned one is still refused",
     decideClaim([{ client_id: "shely", source_client_id: B }], "shely", A),
     { kind: "handle-taken" });
}

console.log("\nClaim — the checks run in the right order");
{
  /* Both conditions true at once: this client holds another handle AND the one
     it is asking for belongs to somebody else. Refusing as "taken" is right,
     because "use the handle you already hold" would send them to a handle they
     cannot have. The worse of two refusals wins. */
  eq("a taken handle outranks holding another",
     decideClaim([
       { client_id: "acme", source_client_id: B },
       { client_id: "acme_fitness", source_client_id: A },
     ], "acme", A),
     { kind: "handle-taken" });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
