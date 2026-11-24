import type { ViewOpts } from "./chart";

const MANAGEMENT = new Set(["import", "unmatched", "rules", "acqos"]);
export const isReportingPreviewView = (view: string) => !MANAGEMENT.has(view);
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i;
const CLIENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Literal server-side opt-in list; any invalid entry disables the entire setting. */
export function isReportingPreviewClient(id: unknown, configured = process.env.GT_REPORTING_PREVIEW_CLIENTS): id is string {
  if (typeof id !== "string" || !configured) return false;
  const entries = configured.split(",").map((entry) => entry.trim());
  return entries.every((entry) => CLIENT_ID.test(entry)) && entries.includes(id);
}

export function allowReportingPreview({
  mode, host, client, reporting, configured,
}: { mode?: string; host?: string | null; client: unknown; reporting: unknown; configured?: string }): boolean {
  return mode === "development" && typeof host === "string" && LOOPBACK.test(host)
    && reporting === "preview" && isReportingPreviewClient(client, configured);
}

export type ReportingViewOpts = ViewOpts & { reportingPreview?: true; previewVs?: string; analysisRound?: string; analysisMetric?: string };
