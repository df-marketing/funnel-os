import type { Row } from "./csv";

export type RoundCodeEvidence = { code: string; count: number; unambiguousCount: number };
export type RoundTagEvidence = {
  rows: number;
  withRoundCode: number;
  withoutRoundCode: number;
  blankTagRows: number;
  multiTagRows: number;
  ambiguousRoundRows: number;
  dominant: RoundCodeEvidence | null;
  topCodes: RoundCodeEvidence[];
  tagColumn: "verified" | "ambiguous";
};
export type LeadOptInDate = { header: string | null; blankRows: number | null };
export type ConfiguredLeadRound = { roundId: string; code: string | null; market: string | null };
export type LeadRoundMatches =
  | { status: "unchecked" | "unavailable" }
  | { status: "verified"; rounds: ConfiguredLeadRound[]; truncated: boolean };
export type LeadDestination = {
  roundId: string; label: string; count: number; declaredOutsideWindow: number;
};

const isTagHeader = (header: string) => ["tag", "tags", "contacttag", "contacttags", "ghltags"]
  .includes(header.toLowerCase().replace(/[^a-z0-9]/g, ""));
// A standalone MMYY-NN or an explicit label such as "round: 1026-01" is
// evidence; digits inside dates, IDs and compound tracking names are not.
const ROUND_CODE = /(?:^|[^A-Za-z0-9_-])((?:0[1-9]|1[0-2])\d{2}-\d{2})(?=$|[^A-Za-z0-9_-])/g;
const MAX_SHOWN_CODES = 5;

/** Counts only. Never return row numbers, original tag text, dates or people,
 * and never turn a suggestion into an attribution input. */
export function inspectLeadRoundTags(headers: readonly string[], rows: readonly Row[]): RoundTagEvidence | null {
  const tagHeaders = headers.filter(isTagHeader);
  if (tagHeaders.length === 0 || rows.length === 0) return null;
  if (tagHeaders.length > 1) return {
    rows: rows.length, tagColumn: "ambiguous", withRoundCode: 0, withoutRoundCode: 0,
    blankTagRows: 0, multiTagRows: 0, ambiguousRoundRows: 0, dominant: null, topCodes: [],
  };

  const header = tagHeaders[0];
  const counts = new Map<string, RoundCodeEvidence>();
  let blankTagRows = 0, multiTagRows = 0, withRoundCode = 0, ambiguousRoundRows = 0;
  for (const row of rows) {
    const raw = row[header]?.trim();
    if (!raw) { blankTagRows++; continue; }
    const tags = raw.split(/[,;|\n]/).filter((tag) => tag.trim() !== "");
    if (!tags.length) { blankTagRows++; continue; }
    if (tags.length > 1) multiTagRows++;
    const codes = new Set<string>();
    for (const tag of tags) for (const hit of tag.matchAll(ROUND_CODE)) codes.add(hit[1]);
    if (!codes.size) continue;
    withRoundCode++;
    if (codes.size > 1) ambiguousRoundRows++;
    for (const code of codes) {
      const entry = counts.get(code) ?? { code, count: 0, unambiguousCount: 0 };
      entry.count++;
      if (codes.size === 1) entry.unambiguousCount++;
      counts.set(code, entry);
    }
  }
  // The denominator includes blank, ambiguous and non-round tags. A small
  // tagged minority is a clue, not a dominant suggested destination.
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const topCodes = ranked.slice(0, MAX_SHOWN_CODES);
  const dominant = ranked.find((entry) => entry.unambiguousCount * 2 > rows.length) ?? null;
  return { tagColumn: "verified", rows: rows.length, withRoundCode, withoutRoundCode: rows.length - withRoundCode,
    blankTagRows, multiTagRows, ambiguousRoundRows, dominant, topCodes };
}

export function inspectLeadOptInDate(rows: readonly Row[], header: string | undefined): LeadOptInDate {
  if (!header) return { header: null, blankRows: null };
  return { header, blankRows: rows.reduce((sum, row) => sum + (row[header]?.trim() ? 0 : 1), 0) };
}

export function leadDateBlock(date: LeadOptInDate | undefined, selectedHeader: string | undefined): string | null {
  if (!selectedHeader) return "A real opt-in date is still required. Map the date column, or upload an export with the original opt-in dates.";
  // The inspect aggregate describes the automatic column only. A different
  // reviewed mapping is checked independently by the final server preview.
  if (date?.header !== selectedHeader || !date.blankRows) return null;
  return `${date.blankRows} ${date.blankRows === 1 ? "row is" : "rows are"} missing a real opt-in date in the mapped column. Map a different date column or upload a corrected export.`;
}
