"use server";

import { headers } from "next/headers";
import { MISSING_INTEGRATION_KEY_MESSAGE } from "@/lib/integration/auth";

/**
 * "Check what we'd send", answered by actually asking.
 *
 * The temptation is to rebuild the payload here out of the same loaders the
 * endpoint uses. That produces a preview that is *like* the response rather than
 * *the* response, and the two would drift the first time a route learned a rule
 * the preview didn't — which is precisely the failure a preview button exists to
 * prevent. So this makes the real HTTP call, with the real shared key, against
 * the real route, and shows what came back including the status code.
 *
 * That makes the button a wire test as well as a preview: a 401 means the two
 * deployments hold different keys, a 503 means one of them holds none, and a 200
 * means AcqOS would get exactly the bytes on screen.
 *
 * Server-only, so the key never reaches the browser. Only the response does, and
 * the response is data this app already renders on every other tab.
 */

export type Preview = {
  kind: "round" | "month";
  /** The URL AcqOS calls, without the key it sends in a header. */
  url: string;
  status: number;
  ok: boolean;
  /** Pretty-printed response, or the transport fault if there wasn't one. */
  body: string;
  /** Set when the fault is this deployment's configuration, not the request. */
  hint: string | null;
  bytes: number;
};

/** Big payloads are shown whole up to here; a report is read, not scrolled forever. */
const MAX_SHOWN = 200_000;

/**
 * Where this deployment is, asked of the request rather than an env var.
 *
 * NEXT_PUBLIC_APP_URL is set, but it names production — so on a preview
 * deployment or a local server this would quietly test the wrong deployment's
 * wire and report a green light for a server nobody is looking at.
 */
async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) throw new Error("no Host header on this request");
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function previewPayload(
  kind: "round" | "month",
  clientId: string,
  periodKey: string,
): Promise<Preview> {
  const path =
    kind === "round"
      ? `/api/integration/round-insight?clientId=${encodeURIComponent(clientId)}&roundId=${encodeURIComponent(periodKey)}`
      : `/api/integration/month-insight?clientId=${encodeURIComponent(clientId)}&month=${encodeURIComponent(periodKey)}`;

  const key = process.env.INTEGRATION_SHARED_KEY;
  const base = await origin();
  const url = `${base}${path}`;

  // Said here rather than let the route answer it, because the route's 503 is
  // about the route's own deployment and this one is about ours. They are the
  // same deployment today and the message would be right by luck.
  if (!key) {
    return {
      kind, url, status: 503, ok: false, bytes: 0,
      body: MISSING_INTEGRATION_KEY_MESSAGE,
      hint:
        "This is the same answer AcqOS would get. Nothing is wrong with the data — " +
        "the key that lets AcqOS ask for it isn't set on this deployment.",
    };
  }

  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-integration-key": key }, cache: "no-store" });
  } catch (e) {
    return {
      kind, url, status: 0, ok: false, bytes: 0,
      body: e instanceof Error ? e.message : String(e),
      hint: "The request never reached the route. This is a transport fault, and it is the one worth retrying.",
    };
  }

  const text = await res.text();
  let body = text;
  try {
    body = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON — an HTML error page, most likely. Shown as it came.
  }

  return {
    kind,
    url,
    status: res.status,
    ok: res.ok,
    bytes: body.length,
    body: body.length > MAX_SHOWN ? `${body.slice(0, MAX_SHOWN)}\n\n… truncated for display.` : body,
    hint:
      res.status === 401
        ? "This deployment and AcqOS are holding different values for INTEGRATION_SHARED_KEY. Set one value on both projects and redeploy both — the key is baked in at build time."
        : res.status === 503
          ? "A key this route needs isn't set on this deployment. The message says which."
          : null,
  };
}
