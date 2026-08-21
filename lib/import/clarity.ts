/**
 * Reading a Microsoft Clarity scroll export.
 *
 * Clarity is the only source here that isn't a table. It writes a block of
 * key/value metadata, a blank line, then the table — so the column mapper in
 * sources.ts, which assumes line 1 is the header, cannot read it at all:
 *
 *     "Project name","Shely's Landing Page 0726-01"
 *     "Date range","05/23/2026 12:00 AM - 05/27/2026 11:59 PM"
 *
 *     "Visited URL matches regex","^https://webinar\.memiai\.online/…$"
 *     "Page views","60"
 *     "Metric","Scroll"
 *
 *     "Scroll depth","No. of visitors","% drop off"
 *     "5","55","5.17"
 *
 * Everything above the table matters. The date range decides which round this
 * describes, the metric name proves it is a scroll export and not a click one,
 * and the page views figure is a trap — see `sessions` below.
 */

import { parseTable, toNumber } from "./csv";

export type ScrollPoint = {
  /** Percent of page height. Clarity emits 5, 10, … 100. */
  depth: number;
  visitors: number;
  /** Clarity's own drop-off figure, kept so `sessions` can be checked. */
  drop_off_pct: number | null;
};

export type ClarityScroll = {
  page_label: string | null;
  url_pattern: string | null;
  device: Device;
  /** Clarity's "Page views" line, recorded but NOT used as the denominator. */
  page_views: number | null;
  /** The denominator every percentage on this curve is a percentage OF. */
  sessions: number;
  captured_from: string | null;
  captured_to: string | null;
  points: ScrollPoint[];
};

export type Device = "mobile" | "desktop" | "tablet" | "all";

export class ClarityError extends Error {
  constructor(message: string, readonly detail?: string[]) { super(message); }
}

const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Clarity writes US order and means it.
 *
 * toDate() in csv.ts resolves an ambiguous slash date day-first, which is right
 * for the SG exports it was written for and wrong here: Clarity is a Microsoft
 * product writing MM/DD/YYYY, so its "05/06/2026" is 6 May and toDate would
 * read it as 5 June. One month out is enough to file a scroll curve against the
 * wrong round, so this source gets its own reader rather than the shared one.
 */
function usDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/**
 * Which device the export covers, read off the file name.
 *
 * Clarity puts the device filter in the download name and nowhere in the file,
 * so this is the only place it exists. Unknown reads as "all" rather than
 * guessing mobile — a desktop curve filed as mobile would be compared against
 * the wrong sessions forever, and nothing downstream could tell.
 */
export function deviceFromName(fileName: string): Device {
  const n = fileName.toLowerCase();
  if (/\bmobile\b|_mobile|-mobile/.test(n)) return "mobile";
  if (/\bdesktop\b|_desktop|-desktop/.test(n)) return "desktop";
  if (/\btablet\b|_tablet|-tablet/.test(n)) return "tablet";
  return "all";
}

/**
 * The number of sessions the curve is a percentage of.
 *
 * NOT "Page views". On the real export those disagree — 60 page views against
 * a curve built on 58 — because a page view that never fired a scroll event
 * (a bounce before the page settled, a reload) is counted as a view and is not
 * in the scroll denominator. Using 60 would understate every retention figure
 * by 3.3% and the error would be invisible.
 *
 * The file states the denominator twice over, once per row: visitors and drop
 * off are two views of the same fraction, so sessions = visitors ÷ (1 − drop).
 * Every row should agree. The mode is taken rather than the first row's answer
 * so one rounded outlier can't set it, and disagreement past a rounding step is
 * reported rather than averaged away.
 */
export function sessionsFrom(points: ScrollPoint[]): { sessions: number; spread: number } {
  const votes = points
    .filter((p) => p.drop_off_pct !== null && p.drop_off_pct < 100)
    .map((p) => Math.round(p.visitors / (1 - p.drop_off_pct! / 100)));

  if (!votes.length) {
    // No drop-off column: the deepest the curve ever got is the best floor we
    // have. It is a floor, not the answer — everyone who bounced before 5% is
    // missing from it — so it is only used when the file gives nothing better.
    return { sessions: Math.max(...points.map((p) => p.visitors), 0), spread: 0 };
  }
  const tally = new Map<number, number>();
  for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);
  const sessions = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return { sessions, spread: Math.max(...votes) - Math.min(...votes) };
}

export function parseClarityScroll(text: string, fileName = ""): ClarityScroll {
  const table = parseTable(text).map((r) => r.map((c) => c.trim()));

  // The metadata block: every line that is a key and one value.
  const meta = new Map<string, string>();
  for (const r of table) {
    if (r.length >= 2 && r[0] && r[1] && !meta.has(canon(r[0]))) meta.set(canon(r[0]), r[1]);
  }

  const metric = meta.get("metric");
  if (metric && canon(metric) !== "scroll") {
    throw new ClarityError(
      `That Clarity export is the "${metric}" metric, not Scroll.`,
      [
        "Only the Scroll export has a depth curve to compare against Lead Gen %.",
        'In Clarity, open the scroll heatmap and export from there — the file says "Metric","Scroll".',
      ],
    );
  }

  // The curve starts at the row headed "Scroll depth" and runs until the rows
  // stop starting with a number. Found by name rather than by line number
  // because the metadata block has grown a line before now.
  const head = table.findIndex((r) => canon(r[0] ?? "") === "scrolldepth");
  if (head === -1) {
    throw new ClarityError("That file has no scroll-depth table in it.", [
      'Expected a row reading "Scroll depth","No. of visitors","% drop off".',
      "A Clarity export of a different metric, or a partial download, looks like this.",
    ]);
  }

  const points: ScrollPoint[] = [];
  for (const r of table.slice(head + 1)) {
    const depth = toNumber(r[0]);
    const visitors = toNumber(r[1]);
    if (depth === null || visitors === null) {
      if (r.some((c) => c !== "")) break;   // a new block started; the curve is done
      continue;                              // blank line inside the table
    }
    points.push({ depth, visitors, drop_off_pct: toNumber(r[2]) });
  }

  if (points.length < 2) {
    throw new ClarityError("That scroll export has fewer than two depth readings in it.", [
      `Found ${points.length}. A usable curve needs at least a top and a bottom.`,
    ]);
  }
  points.sort((a, b) => a.depth - b.depth);

  const range = meta.get("daterange") ?? "";
  const [fromRaw, toRaw] = range.split(/\s+-\s+/);
  const { sessions } = sessionsFrom(points);

  return {
    page_label: meta.get("projectname") ?? null,
    url_pattern: meta.get("visitedurlmatchesregex") ?? meta.get("visitedurl") ?? null,
    device: deviceFromName(fileName),
    page_views: toNumber(meta.get("pageviews") ?? null),
    sessions,
    captured_from: fromRaw ? usDate(fromRaw) : null,
    captured_to: toRaw ? usDate(toRaw) : null,
    points,
  };
}
