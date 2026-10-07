import { SOURCES, type SourceKey } from "./sources";

/**
 * WHICH FILE IS THIS?
 *
 * Five drop zones asked the operator a question the file already answers. For a
 * client like Shely that is four answers a week; for one like i-Care, whose
 * whole journey arrives on the ad row, it is four panes that will never be used
 * and a "next up" prompt pointing at a leads file that does not exist.
 *
 * So the file is identified from its own columns and routed. One drop zone.
 *
 * ── WHY "ALL REQUIRED FIELDS PRESENT" IS NOT ENOUGH ───────────────────────
 *
 * The required sets overlap, and not symmetrically:
 *
 *   leads      needs email + event_date
 *   sales      needs email + event_date + product + amount   ← also satisfies leads
 *   attendance needs round_id + email                        ← leads has round_id too
 *
 * So a sales file is a valid leads file by that test, and a leads export
 * carrying round_id is a valid attendance file. Picking the first match would
 * file revenue as opt-ins, quietly, and the totals would still add up.
 *
 * ── WHAT ACTUALLY DECIDES ─────────────────────────────────────────────────
 *
 * Fields that belong to exactly ONE source. `spend` is only ever ads;
 * `minutes_watched` is only ever attendance; `amount` and `product` are only
 * ever sales. Those are computed from the specs rather than listed here, so a
 * field added to a spec tomorrow becomes a discriminator — or stops being one —
 * without anybody remembering this file exists.
 *
 * A source wins by having STRICTLY MORE discriminators than the runner-up. Tie,
 * or none at all, and it says so instead of guessing: an operator told "I think
 * this is sales, is it?" loses two seconds, and one whose leads file was
 * silently imported as attendance loses a week.
 */

export type Detection =
  | { kind: "sure"; source: SourceKey; why: string }
  | { kind: "unsure"; candidates: Array<{ source: SourceKey; why: string }> }
  | { kind: "unknown"; why: string };

const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

type Field = { field: string; required: boolean; aliases: string[]; prefixes?: string[] };
type Spec = { fields?: Field[] };

/**
 * Does this header name this field? Exact alias first, then prefix — the same
 * order the importer uses, so detection and import can never disagree about
 * whether a column was found.
 */
function names(f: Field, header: string): boolean {
  if (f.aliases.some((a) => canon(a) === header)) return true;
  return (f.prefixes ?? []).some((p) => header.startsWith(canon(p)));
}

/**
 * Field names belonging to exactly one source.
 *
 * Computed, not listed. The point is that it keeps up with the specs: if
 * `round_id` were ever removed from leads, it would become a discriminator for
 * attendance here without anyone editing this file.
 */
function discriminators(): Map<string, SourceKey> {
  const owners = new Map<string, Set<SourceKey>>();
  for (const key of ["ads", "leads", "attendance", "sales"] as SourceKey[]) {
    for (const f of ((SOURCES as Record<string, Spec>)[key].fields ?? [])) {
      const s = owners.get(f.field) ?? new Set<SourceKey>();
      s.add(key); owners.set(f.field, s);
    }
  }
  const out = new Map<string, SourceKey>();
  for (const [field, set] of owners) if (set.size === 1) out.set(field, [...set][0]);
  return out;
}

/**
 * @param headers the file's header row, verbatim
 * @param firstColumn the first cell of each row — Clarity's scroll table is
 *        found by a literal "Scroll depth" label partway down a file whose
 *        header row says something else entirely.
 */
export function detectSource(headers: string[], firstColumn: string[] = []): Detection {
  const have = new Set(headers.map(canon).filter(Boolean));

  /* Clarity first, and by its own marker rather than by field matching: its
     export has no header row this would recognise, and the scroll spec declares
     no fields at all. */
  if ([...headers, ...firstColumn].some((c) => canon(c) === "scrolldepth")) {
    return { kind: "sure", source: "scroll", why: "it has Clarity's scroll-depth table" };
  }

  const disc = discriminators();
  const scored: Array<{ source: SourceKey; hits: string[]; missing: string[] }> = [];

  for (const key of ["ads", "leads", "attendance", "sales"] as SourceKey[]) {
    const fields = (SOURCES as Record<string, Spec>)[key].fields ?? [];
    const matched = new Map<string, boolean>();
    for (const f of fields) {
      if ([...have].some((h) => names(f, h))) matched.set(f.field, f.required);
    }
    const missing = fields.filter((f) => f.required && !matched.has(f.field)).map((f) => f.field);
    if (missing.length) continue;                      // not a candidate at all
    const hits = [...matched.keys()].filter((f) => disc.get(f) === key);
    scored.push({ source: key, hits, missing });
  }

  if (!scored.length) {
    return {
      kind: "unknown",
      why: "no source has all its required columns here. Check the header row — the templates show the shortest version of each file.",
    };
  }

  scored.sort((a, b) => b.hits.length - a.hits.length);
  const [best, next] = scored;

  // A clear winner needs strictly more distinctive columns than anything else.
  if (best.hits.length > 0 && (!next || best.hits.length > next.hits.length)) {
    return {
      kind: "sure",
      source: best.source,
      why: `it has ${best.hits.slice(0, 3).join(", ")}${best.hits.length > 3 ? ` and ${best.hits.length - 3} more` : ""}, which only ${best.source} has`,
    };
  }

  return {
    kind: "unsure",
    candidates: scored.map((s) => ({
      source: s.source,
      why: s.hits.length
        ? `has ${s.hits.join(", ")}`
        : "has every column it requires, and nothing that rules the others out",
    })),
  };
}
