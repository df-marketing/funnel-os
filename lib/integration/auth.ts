import { timingSafeEqual } from "node:crypto";

/**
 * Machine-to-machine authentication for the AcqOS integration.
 *
 * This app deliberately has no user login. The integration routes are instead
 * reachable only by a server that knows the shared secret. Keep this module
 * server-only: neither the secret nor this check belongs in a client bundle.
 */
export function hasIntegrationKey(request: Request): boolean {
  const expected = process.env.INTEGRATION_SHARED_KEY;
  if (!expected) return false;

  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(request.headers.get("x-integration-key") ?? "");
  const sameLength = receivedBytes.length === expectedBytes.length;
  // timingSafeEqual requires equally sized buffers. Comparing a same-sized
  // dummy buffer keeps the comparison path the same for a malformed key.
  const candidate = sameLength ? receivedBytes : Buffer.alloc(expectedBytes.length);

  return timingSafeEqual(expectedBytes, candidate) && sameLength;
}
