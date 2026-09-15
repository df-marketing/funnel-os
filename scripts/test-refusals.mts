/**
 * THE REFUSAL CONTRACT IS FROZEN HERE.
 *
 * AcqOS branches on `code` and `recover`. If either is ever renamed, their
 * branch stops matching and nothing tells anybody — which is the exact failure
 * /api/integration/refusals exists to prevent, happening one level up.
 *
 * TypeScript does not catch it. Renaming a key in REFUSALS and its call site in
 * the same commit typechecks cleanly and ships a breaking change.
 *
 * So the contract is written out again below, as literals, by hand. This file
 * is deliberately duplicated data — that is the point. It is the copy that does
 * not move when someone edits the other one.
 *
 *   adding a code            → passes, no version bump
 *   renaming a code          → FAILS here
 *   removing a code          → FAILS here
 *   changing a status        → FAILS here
 *   changing a recover value → FAILS here
 *
 * To ship a breaking change you must edit the block below, and that is a line
 * in a diff a reviewer can see. That is the whole mechanism.
 */
import { REFUSALS, REFUSAL_CODES, CONTRACT_VERSION, isRefusalCode, refuse } from "../lib/integration/codes";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

/* ── THE FROZEN CONTRACT — v1, agreed with AcqOS 15 September 2026 ──────────
   Do not edit to make a test pass. Editing this is the breaking change. */
const FROZEN: Record<string, { status: number; recover: string }> = {
  handle_taken:       { status: 409, recover: "mint-new-handle" },
  source_holds_other: { status: 409, recover: "use-held-handle" },
  handle_not_claimed: { status: 404, recover: "claim-first" },
  handle_mismatch:    { status: 409, recover: "mint-new-handle" },
};

console.log("\nevery frozen code still exists, unchanged");
for (const [code, want] of Object.entries(FROZEN)) {
  const live = (REFUSALS as Record<string, { status: number; recover: string }>)[code];
  if (!live) {
    fail++;
    console.log(`  FAIL ${code} — REMOVED OR RENAMED. AcqOS branches on this string.`);
    continue;
  }
  eq(`${code} status`, live.status, want.status);
  eq(`${code} recover`, live.recover, want.recover);
}

console.log("\nnothing was dropped");
eq("frozen codes are all present",
  Object.keys(FROZEN).filter((c) => !REFUSAL_CODES.includes(c as never)), []);

console.log("\nadditions are allowed, and are announced");
{
  const added = REFUSAL_CODES.filter((c) => !(c in FROZEN));
  if (added.length) {
    console.log(`  note  ${added.length} code(s) added since v${CONTRACT_VERSION}: ${added.join(", ")}`);
    console.log("        Append them to FROZEN above. Do NOT bump CONTRACT_VERSION —");
    console.log("        a caller that never heard of them still handles every code it knew.");
  } else {
    console.log("  note  no codes added since the freeze");
  }
  pass++;
}

console.log("\nthe version means what it says");
eq("CONTRACT_VERSION is 1 — bump ONLY for a breaking change", CONTRACT_VERSION, 1);

console.log("\nthe two 409s are still distinguishable");
{
  /* The whole reason `recover` exists. If these two ever collapse to the same
     value, a caller branching correctly on the contract still mints in a loop. */
  eq("handle_taken and source_holds_other share a status",
    REFUSALS.handle_taken.status === REFUSALS.source_holds_other.status, true);
  eq("but never a recovery",
    REFUSALS.handle_taken.recover === REFUSALS.source_holds_other.recover, false);
}

console.log("\nrecover is a closed set a caller can switch on");
eq("every recover value is one of three",
  [...new Set(REFUSAL_CODES.map((c) => REFUSALS[c].recover))].sort(),
  ["claim-first", "mint-new-handle", "use-held-handle"]);

console.log("\nthe helper cannot drift from the table");
for (const code of REFUSAL_CODES) {
  const res = refuse(code, "test");
  eq(`refuse(${code}) uses the table's status`, res.status, REFUSALS[code].status);
}

console.log("\nguards");
eq("isRefusalCode accepts a real code", isRefusalCode("handle_taken"), true);
eq("isRefusalCode rejects a near-miss", isRefusalCode("handle_take"), false);
eq("isRefusalCode rejects a non-string", isRefusalCode(409), false);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) {
  console.log("  A failure here is a BREAKING CHANGE to AcqOS, not a broken test.");
  console.log("  Either revert the rename, or edit FROZEN and bump CONTRACT_VERSION");
  console.log("  and tell AcqOS before it ships.\n");
}
process.exit(fail ? 1 : 0);
