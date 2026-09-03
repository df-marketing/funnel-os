/**
 * Dry run of the real pipeline over Shely's May–August exports.
 *
 * Nothing is written. The database is stubbed with the eleven rounds those
 * files belong to and `planImport` runs exactly as /api/import/preview does,
 * so "what would this import do" is measured rather than argued about.
 *
 * Run: npx tsx scripts/dryrun-shely.mts [dir]
 */

import { readFileSync } from "node:fs";
import { parseCsv } from "../lib/import/csv";
import { SOURCES, mapColumns, type SourceKey } from "../lib/import/sources";
import { planImport, ImportError } from "../lib/import/pipeline";

const DIR = process.argv[2] ?? "/home/pewds/Desktop/pewdiepie/work/ground-truth-testing/_build";

const W: Array<[string, string, string]> = [
  ["0526-02", "2026-05-13", "2026-05-19"], ["0526-03", "2026-05-23", "2026-05-28"],
  ["0626-01", "2026-06-05", "2026-06-09"], ["0626-02", "2026-06-19", "2026-06-23"],
  ["0726-01", "2026-07-01", "2026-07-07"], ["0726-02", "2026-07-09", "2026-07-14"],
  ["0726-03", "2026-07-15", "2026-07-21"], ["0726-04", "2026-07-22", "2026-07-30"],
  ["0826-01", "2026-07-31", "2026-08-06"], ["0826-02", "2026-08-07", "2026-08-20"],
  ["0826-03", "2026-08-21", "2026-08-27"], ["0926-01", "2026-08-28", "2026-09-03"],
];
const ROUNDS = W.map(([round_id, start_date, end_date]) => ({
  round_id, client_id: "shely", start_date, end_date, session_date: end_date,
}));

type Tables = Record<string, any[]>;
function fakeDb(tables: Tables) {
  const build = (rows: any[]) => {
    let out = [...rows];
    const api: any = {
      select: () => api,
      eq: (c: string, v: any) => { out = out.filter((r) => r[c] === v); return api; },
      in: (c: string, v: any[]) => { out = out.filter((r) => v.includes(r[c])); return api; },
      not: (c: string) => { out = out.filter((r) => r[c] != null); return api; },
      is: (c: string, v: any) => { out = out.filter((r) => (r[c] ?? null) === v); return api; },
      range: (f: number, t: number) => { out = out.slice(f, t + 1); return api; },
      order: () => api,
      maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
      then: (res: any) => Promise.resolve({ data: out, error: null }).then(res),
    };
    return api;
  };
  return { from: (t: string) => build(tables[t] ?? []) } as any;
}

const state: Tables = {
  rounds: ROUNDS, contacts: [], events: [], ads_performance: [], unmatched_rows: [], v_column_map: [],
};

const FILES: Array<[string, SourceKey]> = [
  ["shely-ads-may-aug.csv", "ads"],
  ["shely-leads-may-aug.csv", "leads"],
  ["shely-attendance-may-aug.csv", "attendance"],
  ["shely-sales-may-aug.csv", "sales"],
];

for (const [file, source] of FILES) {
  const text = readFileSync(`${DIR}/${file}`, "utf8");
  const { headers, rows } = parseCsv(text);
  console.log(`\n${"─".repeat(76)}\n${file}  →  ${source}   (${rows.length} rows)`);
  const { missing, unused } = mapColumns(SOURCES[source], headers);
  if (missing.length) console.log(`  MISSING  ${missing.join(", ")}`);
  if (unused.length) console.log(`  ignored  ${unused.join(" · ")}`);
  try {
    const plan = await planImport(fakeDb(state), { source, clientId: "shely", fileName: file, text });
    const c = plan.counts;
    console.log(`  writes      ${plan.diff.newRows}`);
    console.log(`  matched     exact ${c.matchedExact} · auto ${c.matchedAuto} · new contacts ${c.newContacts}`);
    console.log(`  COUNTED NOT NAMED  ${c.unidentified}`);
    console.log(`  parked      ${c.parked}   duplicates ${c.duplicates}`);
    state.contacts.push(...plan.ops.contacts);
    state.events.push(...plan.ops.events);
    state.ads_performance.push(...plan.ops.ads);
    state.unmatched_rows.push(...plan.ops.unmatched);
  } catch (e) {
    const err = e as ImportError;
    console.log(`  REFUSED  ${err.message}`);
    for (const d of err.detail ?? []) console.log(`           ${d}`);
  }
}

// ── what the app would then read ──────────────────────────────────────────
const ev = state.events;
const per = new Map<string, { leads: number; att: number; anonL: number; anonA: number }>();
for (const [rid] of W) per.set(rid, { leads: 0, att: 0, anonL: 0, anonA: 0 });
for (const e of ev) {
  const p = per.get(e.round_id as string);
  if (!p) continue;
  if (e.event_type === "lead") { p.leads++; if (!e.contact_id) p.anonL++; }
  if (e.event_type === "attendance") { p.att++; if (!e.contact_id) p.anonA++; }
}
const MASTER: Record<string, [number, number]> = {
  "0526-02": [207, 50], "0526-03": [208, 80], "0626-01": [130, 40], "0626-02": [144, 55],
  "0726-01": [146, 61], "0726-02": [134, 53], "0726-03": [105, 54], "0726-04": [110, 44],
  "0826-01": [97, 29], "0826-02": [97, 48], "0826-03": [89, 53],
};
console.log(`\n${"═".repeat(76)}\n${"ROUND".padEnd(10)}${"LEADS".padStart(7)}${"(anon)".padStart(8)}${"master".padStart(8)}${"Δ".padStart(6)}   ${"ATT".padStart(5)}${"(anon)".padStart(8)}${"master".padStart(8)}${"Δ".padStart(6)}`);
let TL = 0, TA = 0, ML = 0, MA = 0;
for (const [rid] of W) {
  const p = per.get(rid)!;
  const m = MASTER[rid];
  if (!m) continue;
  TL += p.leads; TA += p.att; ML += m[0]; MA += m[1];
  const d = (a: number, b: number) => (a - b === 0 ? "  ✓" : `${a - b > 0 ? "+" : ""}${a - b}`).padStart(6);
  console.log(
    rid.padEnd(10) + String(p.leads).padStart(7) + `(${p.anonL})`.padStart(8) + String(m[0]).padStart(8) + d(p.leads, m[0]) +
    "   " + String(p.att).padStart(5) + `(${p.anonA})`.padStart(8) + String(m[1]).padStart(8) + d(p.att, m[1]),
  );
}
console.log("─".repeat(76));
console.log("TOTAL".padEnd(10) + String(TL).padStart(7) + "".padStart(8) + String(ML).padStart(8) + String(TL - ML).padStart(6) +
  "   " + String(TA).padStart(5) + "".padStart(8) + String(MA).padStart(8) + String(TA - MA).padStart(6));
console.log(`\nshow rate   ${(100 * TA / TL).toFixed(1)}%   (master ${(100 * MA / ML).toFixed(1)}%)`);
console.log(`still parked ${state.unmatched_rows.length}`);
