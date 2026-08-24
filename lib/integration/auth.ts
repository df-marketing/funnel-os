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
 */
export type KeyCheck = "ok" | "unauthorized" | "unconfigured";

export const MISSING_INTEGRATION_KEY_MESSAGE =
  "INTEGRATION_SHARED_KEY isn't set on this deployment. Generate a secret, run " +
  "`vercel env add INTEGRATION_SHARED_KEY` for Production and Preview, set the same " +
  "value in AcqOS, and redeploy. The app runs without it; the integration cannot.";

export function checkIntegrationKey(request: Request): KeyCheck {
  const expected = process.env.INTEGRATION_SHARED_KEY;
  if (!expected) return "unconfigured";

  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(request.headers.get("x-integration-key") ?? "");
  const sameLength = receivedBytes.length === expectedBytes.length;
  // timingSafeEqual requires equally sized buffers. Comparing a same-sized
  // dummy buffer keeps the comparison path the same for a malformed key.
  const candidate = sameLength ? receivedBytes : Buffer.alloc(expectedBytes.length);

  return timingSafeEqual(expectedBytes, candidate) && sameLength ? "ok" : "unauthorized";
}
