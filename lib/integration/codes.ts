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
export type Recovery = "mint-new-handle" | "use-held-handle" | "claim-first";

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
