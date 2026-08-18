/**
 * Dry run of the supervisor's test pack — the four files, in the order the
 * README gives them, against an empty database.
 *
 * Nothing is written. The stub carries state between files exactly as four
 * real commits would, so the numbers printed here are the numbers the app will
 * show — measured by running the real planImport, not estimated.
 *
 * Run: npx tsx scripts/dryrun-pack.mts [dir]
 */
import { readFileSync } from "node:fs";
import { parseCsv } from "../lib/import/csv";
import { mapColumns, type SourceKey } from "../lib/import/sources";
import { planImport, ImportError } from "../lib/import/pipeline";

const DIR = process.argv[2] ?? "/home/pewds/Downloads/funnel-os-test";

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

const FILES: Array<{ file: string; source: SourceKey }> = [
  { file: "1-ads.csv", source: "ads" },
  { file: "2-leads.csv", source: "leads" },
  { file: "3-attendance.csv", source: "attendance" },
  { file: "4-sales.csv", source: "sales" },
];

for (const { file, source } of FILES) {
  const text = readFileSync(`${DIR}/${file}`, "utf8");
  const { headers, rows } = parseCsv(text);
  console.log(`\n${"─".repeat(74)}\n${file}   →   ${source}   (${rows.length} data rows)`);
  const { missing, unused } = mapColumns(source, headers);
  if (missing.length) console.log(`  MISSING  ${missing.join(", ")}`);
  if (unused.length) console.log(`  ignored  ${unused.join(" · ")}`);
  try {
    const plan = await planImport(fakeDb(state), { source, clientId: "shely", fileName: file, text });
    console.log(`  coverage ${plan.coverage.start} → ${plan.coverage.end}`);
    console.log(`  matched  exact ${plan.counts.matchedExact} · auto ${plan.counts.matchedAuto} · new contacts ${plan.counts.newContacts}`);
    console.log(`  PARKED   ${plan.counts.parked}   duplicates ${plan.counts.duplicates}`);
    console.log(`  attrib   ad set ${plan.attribution.utm} · date-window ${plan.attribution.dateWindow} · none ${plan.attribution.none}`);
    console.log(`  would write ${plan.diff.newRows} rows`);
    const why: Record<string, number> = {};
    for (const u of plan.ops.unmatched as any[]) why[u.reason] = (why[u.reason] ?? 0) + 1;
    if (Object.keys(why).length) console.log(`  parked because ${JSON.stringify(why)}`);
    for (const w of plan.warnings.slice(0, 4)) console.log(`  warn     ${w}`);
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

console.log(`\n${"═".repeat(74)}  FINAL STATE`);
const byRound: Record<string, Record<string, number>> = {};
for (const e of state.events as any[]) {
  const r = (byRound[e.round_id] ??= {});
  r[e.event_type] = (r[e.event_type] ?? 0) + 1;
}
for (const [rid, kinds] of Object.entries(byRound).sort())
  console.log(`  ${rid}  ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(" · ")}`);

const spend = (state.ads_performance as any[]).reduce((a, r) => a + Number(r.spend ?? 0), 0);
const rev = (state.events as any[]).filter((e) => e.event_type === "sale")
  .reduce((a, e) => a + Number(e.amount ?? 0), 0);
const held = (state.unmatched_rows as any[]).reduce((a, r) => a + Number(r.revenue_held ?? 0), 0);
const adsets = new Set((state.events as any[]).filter((e) => e.ad_set).map((e) => e.ad_set));
const ads = new Set((state.events as any[]).filter((e) => e.ad).map((e) => e.ad));
console.log(`  contacts ${state.contacts.length} · events ${state.events.length} · parked ${state.unmatched_rows.length}`);
console.log(`  spend ${spend.toFixed(2)} · revenue ${rev.toFixed(2)} · held ${held.toFixed(2)}`);
console.log(`  audiences on leads ${adsets.size} · creatives on leads ${ads.size}`);
console.log(`  [${[...adsets].sort().join(", ")}]`);

// ── Optional: emit the plan as SQL, so the views can be read for real ───────
// A dry run proves the pipeline accepts the files. It does not prove the
// dashboard adds them up correctly. Piping these inserts into a database that
// has had ALL.sql and 0-wipe.sql applied closes that gap: the numbers in the
// README then come from the same views the app reads, not from this script's
// own arithmetic.
if (process.argv.includes("--sql")) {
  const q = (v: any) =>
    v === null || v === undefined || v === "" ? "null" : `'${String(v).replace(/'/g, "''")}'`;
  const out: string[] = [];
  for (const c of state.contacts as any[])
    out.push(`insert into contacts (contact_id, email, phone, client_id) values (${q(c.contact_id)}, ${q(c.email)}, ${q(c.phone)}, ${q(c.client_id)});`);
  for (const a of state.ads_performance as any[])
    out.push(`insert into ads_performance (round_id, date, campaign, ad_set, ad, spend, impressions, reach, clicks) values (${q(a.round_id)}, ${q(a.date)}, ${q(a.campaign)}, ${q(a.ad_set)}, ${q(a.ad)}, ${q(a.spend)}, ${q(a.impressions)}, ${q(a.reach)}, ${q(a.clicks)});`);
  for (const e of state.events as any[])
    out.push(`insert into events (contact_id, round_id, event_type, event_date, lead_round_id, close_round_id, attribution_method, utm_campaign, ad_set, ad, source, match_status, product, minutes_watched, amount, is_lead) values (${q(e.contact_id)}, ${q(e.round_id)}, ${q(e.event_type)}, ${q(e.event_date)}, ${q(e.lead_round_id)}, ${q(e.close_round_id)}, ${q(e.attribution_method)}, ${q(e.utm_campaign)}, ${q(e.ad_set)}, ${q(e.ad)}, ${q(e.source)}, ${q(e.match_status)}, ${q(e.product)}, ${q(e.minutes_watched)}, ${q(e.amount)}, ${e.is_lead ? "true" : "false"});`);
  for (const u of state.unmatched_rows as any[])
    out.push(`insert into unmatched_rows (client_id, source, reason, best_guess, revenue_held, raw_data, auto_resolved) values (${q(u.client_id)}, ${q(u.source)}, ${q(u.reason)}, ${q(u.best_guess)}, ${q(u.revenue_held)}, ${q(JSON.stringify(u.raw_data ?? {}))}::jsonb, false);`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.argv[process.argv.indexOf("--sql") + 1], out.join("\n") + "\n");
  console.log(`\n  wrote ${out.length} inserts`);
}
