/**
 * The refusal contract.
 *
 * Four codes travelled as bare string literals in two route files, and the
 * handover doc described them in prose a third time. Three copies of a contract
 * is zero copies of a contract: nothing makes them agree, and the one that goes
 * stale is whichever nobody is looking at.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Two of the four are 409 and they want
 * OPPOSITE responses. `handle_taken` means the name is spoken for — mint a new
 * one. `source_holds_other` means the caller already has a handle — minting a
 * new one produces a SECOND handle for one client, which is the drift the
 * unique index exists to prevent. A caller that branches on the HTTP status
 * cannot tell them apart, and the failure mode is an infinite mint loop that
 * looks like it is making progress.
 *
 * So `recover` is the field that carries the difference, and it is an enum
 * rather than a sentence. `retry` stays because AcqOS reads it, but a sentence
 * is for a human reading a log — nothing should branch on it.
 *
 * WHAT IS DELIBERATELY NOT HERE. 400 (shape), 401 (key), 503 (unconfigured) and
 * 500 are not refusals in this sense. They mean the request never got as far as
 * a decision about a handle. Adding them would put "your JSON is malformed" in
 * the same enum as "that handle belongs to someone else", and callers would
 * start treating a typo as a business outcome.
 */

import { NextResponse } from "next/server";

/**
 * What the caller should DO. This is the branch, not the status.
 *
 * - `mint-new-handle` — the handle is unavailable to you. Choose another.
 * - `use-held-handle` — stop. You already have one; it is in `heldHandle`.
 * - `claim-first`     — the handle does not exist here yet. POST client-handle.
 */
export type Recovery = "mint-new-handle" | "use-held-handle" | "claim-first" | "import-first";

/**
 * THE CONTRACT IS ADDITIVE-ONLY, AND THIS IS WHAT MAKES THAT TRUE.
 *
 * AcqOS asked the right question: serving the contract is worth nothing if a
 * rename can ship. TypeScript does not save us — renaming a key here and its
 * call site together typechecks perfectly and breaks AcqOS silently, which is
 * the original bug one level up.
 *
 * So scripts/test-refusals.mts holds a FROZEN LITERAL COPY of every code, its
 * status and its recover value. Adding a code passes. Renaming, removing, or
 * changing the status or recover of an existing one FAILS THE TEST. The only
 * way to ship a breaking change is to edit the frozen copy, which is a visible,
 * deliberate line in a diff rather than a rename nobody notices.
 *
 * Bump CONTRACT_VERSION only for a breaking change. AcqOS asserts on it:
 * if it still reads 1, nothing they match on has moved.
 *
 * ADDING A CODE. Append to REFUSALS and to the frozen copy in the test. Do not
 * bump the version — a caller that has never heard of the new code still
 * handles every code it knew about, which is what additive means.
 */
export const CONTRACT_VERSION = 1;

export const REFUSALS = {
  handle_taken: {
    status: 409,
    recover: "mint-new-handle",
    retry: "mint a different handle and claim again",
    means: "a different AcqOS client holds this handle",
  },
  source_holds_other: {
    status: 409,
    recover: "use-held-handle",
    retry: "none — use the handle you already hold",
    means: "this AcqOS client already holds a different handle",
  },
  handle_not_claimed: {
    status: 404,
    recover: "claim-first",
    retry: "claim the handle at /api/integration/client-handle first",
    means: "no such handle in GroundTruth",
  },
  handle_mismatch: {
    status: 409,
    recover: "mint-new-handle",
    retry: "mint a different handle, claim it, then call this again",
    means: "the handle exists but belongs to a different AcqOS client",
  },
  /**
   * Added 15 Sep 2026, at contractVersion 1, because it is additive.
   *
   * The period has ended but the imports have not reached the end of it, so a
   * reading taken now is built on a window the data does not cover. Freezing it
   * writes that gap into a record whose whole purpose is to outlive the
   * calculation.
   *
   * NOT the same question as `force`. `force` says "I know the period is not
   * over." This says "I know the data is short." Conflating them is how a round
   * gets frozen on the first day of its own window with every step reporting no
   * reading — and a weak stage named anyway.
   *
   * So `force` does NOT override this. `acknowledgeStale: true` does, and it
   * has to be passed on purpose.
   */
  period_not_final: {
    status: 409,
    recover: "import-first",
    retry: "import the missing data, then freeze — or pass acknowledgeStale: true to freeze the gap deliberately",
    means: "the period has ended but the imported data stops before it does",
  },
} as const satisfies Record<string, {
  status: number;
  recover: Recovery;
  retry: string;
  means: string;
}>;

export type RefusalCode = keyof typeof REFUSALS;

export const REFUSAL_CODES = Object.keys(REFUSALS) as RefusalCode[];

export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && value in REFUSALS;
}

/**
 * Build a refusal. The status comes FROM the code, so the pair cannot drift —
 * which is the whole reason this function exists rather than an object literal
 * at each call site.
 *
 * `error` is the human sentence, and it is per-call because it names the
 * specific handle. `extra` carries the one field a caller needs to act on —
 * today that is only `heldHandle`.
 */
export function refuse(
  code: RefusalCode,
  error: string,
  extra: Record<string, unknown> = {},
) {
  const refusal = REFUSALS[code];
  return NextResponse.json(
    { ok: false, code, error, recover: refusal.recover, retry: refusal.retry, ...extra },
    { status: refusal.status },
  );
}
