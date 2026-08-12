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

export function parseCsv(input: string): { headers: string[]; rows: Row[] } {
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
 * Dates arrive as ISO, DD/MM/YYYY and "5 Jun 2026" depending on the export.
 * Ambiguous D/M vs M/D is resolved as day-first: these are SG exports, and
 * guessing US order would silently move a lead into the wrong round.
 */
export function toDate(v: string | undefined | null): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slash) {
    const [, d, m, y] = slash;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

/**
 * Date-only values land at END of day, not midday.
 *
 * Payment exports routinely carry a date with no time. close_round_id is "the
 * most recent attendance BEFORE the purchase" — and the class that sold it ran
 * at 8pm on the same date. Timestamping such a sale at noon puts it before its
 * own class, so the closing credit silently vanishes and the class looks like it
 * converted nobody. End-of-day means "some time that day, after whatever else
 * happened", which is the only safe reading when the time is genuinely unknown.
 */
export function toTimestamp(v: string | undefined | null): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime()) && /[:T]/.test(s)) return direct.toISOString();
  const d = toDate(s);
  return d ? new Date(`${d}T23:59:59Z`).toISOString() : null;
}
