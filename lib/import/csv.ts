/**
 * A small, correct CSV reader.
 *
 * Meta and payment exports routinely contain quoted fields with embedded commas
 * ("Cold_Broad, 25-45"), embedded newlines in ad copy, doubled quotes, CRLF line
 * endings and a UTF-8 BOM. A split(",") loses data silently on all five, and a
 * silent data loss in an import tool is the worst possible bug — so this parses
 * properly rather than approximately.
 */

export type Row = Record<string, string>;

/**
 * The file as a grid, before anything decides which line is the header.
 *
 * Most exports are a header and then rows, which is what parseCsv builds on top
 * of this. A Microsoft Clarity export is not: it opens with half a dozen
 * key/value lines, then a blank line, then the table — so the header is line 12
 * and lines 1-11 are the metadata that says what was measured and when. That
 * reader needs the grid, and it must be THIS grid: Clarity quotes every cell,
 * and page titles carry commas and apostrophes.
 */
export function parseTable(input: string): string[][] {
  const text = input.replace(/^﻿/, ""); // strip BOM
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); table.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }  // escaped quote
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { endField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { endRow(); i++; continue; }
    field += c; i++;
  }
  // trailing field/row, unless the file ended on a clean newline
  if (field !== "" || row.length) endRow();
  return table;
}

export function parseCsv(input: string): { headers: string[]; rows: Row[] } {
  const table = parseTable(input);

  // Drop wholly blank lines, and lines whose first cell starts with "#".
  // The downloadable templates carry a "#"-prefixed legend, and someone will
  // forget to delete it; no real value in any of these files — a date, an email,
  // a round id — begins with a hash, so skipping them is safe.
  const clean = table.filter(
    (r) => r.some((c) => c.trim() !== "") && !r[0]?.trim().startsWith("#"),
  );
  if (!clean.length) return { headers: [], rows: [] };

  const headers = clean[0].map((h) => h.trim());
  const rows = clean.slice(1).map((r) => {
    const o: Row = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] ?? "").trim(); });
    return o;
  });

  return { headers, rows };
}

/**
 * Rows back out to CSV — the inverse of parseCsv, and it has to be exact.
 *
 * Resolving a parked row replays it through the real import pipeline, and the
 * pipeline reads CSV. A row that survived parseCsv can hold commas, quotes and
 * newlines, so writing it back with join(",") would corrupt on the way out the
 * exact values this parser was careful about on the way in.
 */
export function writeCsv(headers: string[], rows: Row[]): string {
  const cell = (v: string) =>
    /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [
    headers.map(cell).join(","),
    ...rows.map((r) => headers.map((h) => cell(r[h] ?? "")).join(",")),
  ].join("\n");
}

/** Numbers arrive as "1,284", "SGD 1,378.24", "12.5%", "(45.00)" for negatives. */
export function toNumber(v: string | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "" || s === "-" || s === "—") return null;
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()]/g, "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Every client, every webinar and every ad account here runs on UTC+8, and the
 * app runs on a server that does not. A time with no zone on it is a LOCAL time
 * — reading it as UTC moves an 8pm class to 4am the next morning.
 */
const LOCAL_OFFSET = "+08:00";

const hasZone = (s: string) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);

/**
 * The calendar day an instant falls on HERE, not in UTC.
 *
 * Storing instants in UTC is right; bucketing them by their UTC day is not.
 * Round windows are local calendar dates — 0526-03 runs "23–27 May" as read off
 * a Singapore wall calendar — so a 4am opt-in on the 23rd is a 23rd opt-in. Its
 * UTC day is the 22nd, which would file it under the previous round.
 *
 * UTC+8 has never observed DST, so the shift is a constant and this needs no
 * timezone database.
 */
export const localDay = (iso: string): string =>
  new Date(new Date(iso).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

/**
 * WHICH WAY ROUND A COLUMN OF SLASH DATES IS WRITTEN.
 *
 * Decided ONCE from every value in the column, not per value — which is the
 * whole point, and what this is for.
 *
 * A single value can only prove the order when one of its halves exceeds 12.
 * 9/17/2026 has no seventeenth month, so it is month-first; 10/6/2026 proves
 * nothing on its own. Judging each value alone therefore reads one file two
 * different ways, and the one it reads wrongly is the one nobody checks.
 *
 * That is not hypothetical. Shely's attendance for 1026-01 arrived as
 * 10/6/2026 in a column whose other three dates were 9/17, 9/24 and 9/30 —
 * month-first beyond doubt. Read alone it fell to the day-first default and
 * became 10 June 2026, four months early, and the October class showed no
 * attendance at all while June gained forty people. Nothing failed.
 *
 * `conflict` means the column contains both 17/9 and 9/17 — genuinely two
 * formats in one column, which no single rule can resolve. The caller is told
 * rather than guessed at.
 */
export type DateOrder = "dmy" | "mdy" | "ambiguous" | "conflict";

const SLASH = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/;

export function inferDateOrder(values: Iterable<string | undefined | null>): DateOrder {
  let dmy = false, mdy = false;
  for (const v of values) {
    if (!v) continue;
    const m = SLASH.exec(String(v).trim());
    if (!m) continue;                       // ISO, or a name like "5 Jun 2026"
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) dmy = true;      // 17/9 — only day-first parses
    else if (b > 12 && a <= 12) mdy = true; // 9/17 — only month-first parses
  }
  if (dmy && mdy) return "conflict";
  if (dmy) return "dmy";
  if (mdy) return "mdy";
  return "ambiguous";
}

/**
 * Y/M/D out of a date string.
 *
 * `order` is the column's verdict from inferDateOrder. Without it, or when the
 * column could not decide, the old rule stands: a value that proves its own
 * order is believed, and anything still ambiguous is read day-first, because
 * these are SG exports and JavaScript's own parser would silently pick US
 * order and move a lead into the wrong round.
 *
 * A value that CONTRADICTS the column — 17/9 in a column settled as
 * month-first — is read on its own terms rather than forced into an
 * impossible month. One odd row does not get to be wrong twice.
 */
function ymd(s: string, order?: DateOrder): [string, string, string] | null {
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return [iso[1], iso[2].padStart(2, "0"), iso[3].padStart(2, "0")];

  const slash = s.match(SLASH);
  if (slash) {
    const [, a, b, y] = slash;
    const dayFirst =
      Number(a) > 12 ? true
      : Number(b) > 12 ? false
      : order === "mdy" ? false
      : order === "dmy" ? true
      : true;
    const d = dayFirst ? a : b;
    const m = dayFirst ? b : a;
    if (Number(m) > 12 || Number(d) > 31) return null;
    return [y, m.padStart(2, "0"), d.padStart(2, "0")];
  }
  return null;
}

/** Dates arrive as ISO, DD/MM/YYYY, MM/DD/YYYY and "5 Jun 2026". */
export function toDate(v: string | undefined | null, order?: DateOrder): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  const p = ymd(s, order);
  if (p) return `${p[0]}-${p[1]}-${p[2]}`;

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

/**
 * A full instant, in UTC, from whatever the export wrote.
 *
 * Three cases, and the middle one is where the bug lived:
 *
 *   carries a zone   trust it — GoHighLevel writes +08:00 and means it
 *   time, no zone    it's UTC+8. Zoom's "05/19/2026 07:32:09 PM" is a 7:32pm
 *                    Singapore class, not a 7:32pm UTC one.
 *   no time at all   END of the local day, not midday.
 *
 * That last rule matters because close_round_id is "the most recent attendance
 * BEFORE the purchase", and the class that sold it ran at 8pm on the same date.
 * Timestamping such a sale at noon puts it before its own class, so the closing
 * credit silently vanishes and the class looks like it converted nobody.
 */
export function toTimestamp(v: string | undefined | null, order?: DateOrder): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  const time = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?[Mm]?/);
  if (!time) {
    const d = toDate(s, order);
    return d ? new Date(`${d}T23:59:59${LOCAL_OFFSET}`).toISOString() : null;
  }

  if (hasZone(s)) {
    const direct = new Date(s);
    return Number.isNaN(direct.getTime()) ? null : direct.toISOString();
  }

  const d = toDate(s, order);
  if (!d) return null;

  let h = Number(time[1]);
  const half = time[4]?.toLowerCase();
  if (half === "p" && h < 12) h += 12;
  if (half === "a" && h === 12) h = 0;
  if (h > 23) return null;

  const clock = `${String(h).padStart(2, "0")}:${time[2]}:${time[3] ?? "00"}`;
  const out = new Date(`${d}T${clock}${LOCAL_OFFSET}`);
  return Number.isNaN(out.getTime()) ? null : out.toISOString();
}
