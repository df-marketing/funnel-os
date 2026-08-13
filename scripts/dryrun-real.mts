/**
 * Dry run of the real import pipeline against the files the supervisor sent.
 *
 * Nothing is written anywhere — this stubs the database with the two rounds
 * those files belong to and runs `planImport` exactly as the app's
 * /api/import/preview route does, so the answer to "would these files import"
 * is measured rather than guessed.
 *
 * Run: npx tsx scripts/dryrun-real.mts
 */

import { readFileSync } from "node:fs";
import { parseCsv } from "../lib/import/csv";
import { mapColumns, type SourceKey } from "../lib/import/sources";
import { planImport, ImportError } from "../lib/import/pipeline";

/** Folder holding the exports. Override: npx tsx scripts/dryrun-real.mts <dir> */
const DIR = process.argv[2] ?? "/home/pewds/Downloads/WhatSie";

const ROUNDS = [
  { round_id: "0526-02", client_id: "shely", start_date: "2026-05-13", end_date: "2026-05-19", session_date: "2026-05-19" },
  { round_id: "0526-03", client_id: "shely", start_date: "2026-05-23", end_date: "2026-05-27", session_date: "2026-05-28" },
];

type Tables = Record<string, any[]>;
function fakeDb(tables: Tables) {
  const build = (rows: any[]) => {
    let out = [...rows];
    const api: any = {
      select: () => api,
      eq: (c: string, v: any) => { out = out.filter((r) => r[c] === v); return api; },
      in: (c: string, v: any[]) => { out = out.filter((r) => v.includes(r[c])); return api; },
      not: (c: string) => { out = out.filter((r) => r[c] != null); return api; },
      range: (f: number, t: number) => { out = out.slice(f, t + 1); return api; },
      order: () => api,
      maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
      then: (res: any) => Promise.resolve({ data: out, error: null }).then(res),
    };
    return api;
  };
  return { from: (t: string) => build(tables[t] ?? []) } as any;
}

// state carried across files, exactly as it would be across four commits
const state: Tables = {
  rounds: ROUNDS, contacts: [], events: [], ads_performance: [], unmatched_rows: [], v_column_map: [],
};

const FILES: Array<{ file: string; source: SourceKey }> = [
  { file: "0526-02 Data.csv", source: "leads" },
  { file: "0526-03 Leads.csv", source: "leads" },
  { file: "Zoom_participants_full_list.csv", source: "attendance" },
  { file: "participants_89231210453_2026_05_28.csv", source: "attendance" },
];

for (const { file, source } of FILES) {
  const text = readFileSync(`${DIR}/${file}`, "utf8");
  const { headers, rows } = parseCsv(text);
  console.log(`\n${"─".repeat(74)}\n${file}   →   ${source}   (${rows.length} data rows)`);

  const { map, missing, unused } = mapColumns(source, headers);
  console.log(`  mapped   ${Object.entries(map).map(([f, h]) => `${f}←"${h}"`).join("  ") || "(nothing)"}`);
  if (missing.length) console.log(`  MISSING  ${missing.join(", ")}`);
  if (unused.length) console.log(`  ignored  ${unused.join(" · ")}`);

  try {
    const plan = await planImport(fakeDb(state), {
      source, clientId: "shely", fileName: file, text,
    });
    console.log(`  coverage ${plan.coverage.start} → ${plan.coverage.end}`);
    console.log(`  matched  exact ${plan.counts.matchedExact} · auto ${plan.counts.matchedAuto} · new contacts ${plan.counts.newContacts}`);
    console.log(`  PARKED   ${plan.counts.parked}   duplicates ${plan.counts.duplicates}`);
    console.log(`  attrib   utm ${plan.attribution.utm} · date-window ${plan.attribution.dateWindow} · none ${plan.attribution.none}`);
    console.log(`  would write ${plan.diff.newRows} rows`);
    for (const w of plan.warnings.slice(0, 4)) console.log(`  warn     ${w}`);

    // commit into the stub so the next file sees these people
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

// ── What if the one obviously-fixable problem is fixed? ────────────────────
// The Zoom export carries no round column, so the import is refused outright.
// Add one and rerun, to find out whether round_id is the only thing in the way.
for (const [file, round] of [
  ["Zoom_participants_full_list.csv", "0526-02"],
  ["participants_89231210453_2026_05_28.csv", "0526-03"],
] as const) {
  const raw = readFileSync(`${DIR}/${file}`, "utf8").replace(/^﻿/, "");
  const [head, ...body] = raw.split(/\r?\n/).filter((l) => l.trim());
  const patched = [`round_id,${head}`, ...body.map((l) => `${round},${l}`)].join("\n");

  console.log(`\n${"─".repeat(74)}\n${file} + a round_id column   →   attendance`);
  try {
    const plan = await planImport(fakeDb(state), {
      source: "attendance", clientId: "shely", fileName: file, text: patched,
    });
    console.log(`  matched  exact ${plan.counts.matchedExact} · auto ${plan.counts.matchedAuto}`);
    console.log(`  PARKED   ${plan.counts.parked} of ${plan.rowCount}`);
    console.log(`  would write ${plan.diff.newRows} rows`);
    const why: Record<string, number> = {};
    for (const u of plan.ops.unmatched as any[]) why[u.reason] = (why[u.reason] ?? 0) + 1;
    console.log(`  parked because: ${JSON.stringify(why)}`);
  } catch (e) {
    console.log(`  REFUSED  ${(e as ImportError).message}`);
  }
}

console.log(`\n${"═".repeat(74)}`);
console.log(`contacts created ${state.contacts.length} · events ${state.events.length} · parked ${state.unmatched_rows.length}`);
const byRound: Record<string, Record<string, number>> = {};
for (const e of state.events as any[]) {
  const r = (byRound[e.round_id] ??= {});
  r[e.event_type] = (r[e.event_type] ?? 0) + 1;
}
console.log(JSON.stringify(byRound, null, 2));
