import { timingSafeEqual } from "node:crypto";

/**
 * Machine-to-machine authentication for the AcqOS integration.
 *
 * This app deliberately has no user login. The integration routes are instead
 * reachable only by a server that knows the shared secret. Keep this module
 * server-only: neither the secret nor this check belongs in a client bundle.
 *
 * "No key on the server" and "wrong key from the caller" both used to answer a
 * bare 401, which left whoever was wiring AcqOS up unable to tell a mistyped
 * secret from a deployment that never had one. They are different faults with
 * different fixes and different people to go and find, so they answer
 * differently now — the same call the service-role key already makes.
 *
 * There are two keys, because there are two kinds of caller.
 *
 * INTEGRATION_SHARED_KEY reaches everything, and AcqOS holds it. That is right
 * for a program: it calls the eight routes it was written to call and no
 * others, so the key's reach and the caller's reach are the same thing.
 *
 * INTEGRATION_READONLY_KEY reaches the four GET routes only. It exists for
 * callers that choose their own requests at runtime — an agent, a notebook,
 * anything driven by a prompt. Four of these routes create users, grant client
 * access and replace funnel schemas; a caller that decides for itself what to
 * call should not be one keystroke away from them.
 */
export type KeyCheck = "ok" | "unauthorized" | "unconfigured";

/** What a route needs. Routes that read say so; everything else is a write. */
export type Access = "read" | "write";

export const MISSING_INTEGRATION_KEY_MESSAGE =
  "INTEGRATION_SHARED_KEY isn't set on this deployment. Generate a secret, run " +
  "`vercel env add INTEGRATION_SHARED_KEY` for Production and Preview, set the same " +
  "value in AcqOS, and redeploy. The app runs without it; the integration cannot.";

function matches(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  const sameLength = receivedBytes.length === expectedBytes.length;
  // timingSafeEqual requires equally sized buffers. Comparing a same-sized
  // dummy buffer keeps the comparison path the same for a malformed key.
  const candidate = sameLength ? receivedBytes : Buffer.alloc(expectedBytes.length);
  return timingSafeEqual(expectedBytes, candidate) && sameLength;
}

/**
 * `need` defaults to "write" so that a route added later is guarded at the
 * stricter level until someone deliberately says otherwise. Forgetting the
 * argument costs a read route nothing; forgetting it the other way round
 * would silently open a write.
 */
export function checkIntegrationKey(request: Request, need: Access = "write"): KeyCheck {
  const write = process.env.INTEGRATION_SHARED_KEY;
  if (!write) return "unconfigured";

  const received = request.headers.get("x-integration-key") ?? "";
  if (matches(write, received)) return "ok";

  // Set to the same value as the write key, the read-only key would not be
  // read-only — it would already have matched above, and whoever set it would
  // believe in a limit that isn't there. Ignore it rather than pretend.
  const read = process.env.INTEGRATION_READONLY_KEY;
  if (need === "read" && read && read !== write && matches(read, received)) return "ok";

  return "unauthorized";
}
