/**
 * Exercises the import pipeline against a fake database.
 *
 * These are the rules that, if they break, silently corrupt every number in the
 * app — so they get tested rather than eyeballed:
 *   - quoted CSV fields with commas and newlines survive
 *   - a renamed required column refuses the import instead of writing blanks
 *   - plus-addressed emails and reformatted phones auto-resolve to one person
 *   - name-only rows park, never guess
 *   - a UTM lead is attributed by utm; a lead without one is attributed by date
 *     window and SAYS SO on the row
 *   - a sale with no lead event is is_lead=false: in revenue, out of ROAS
 *   - a refund on an already-committed sale raises a restatement warning
 *
 * Run: npx tsx scripts/test-import.ts
 */

import { parseCsv, toNumber, toDate } from "../lib/import/csv";
import { mapColumns, SOURCES } from "../lib/import/sources";
import { buildTemplate } from "../lib/import/template";
import { buildIndex, matchRow, normPhone, normEmail, stripPlus } from "../lib/import/identity";
import { attributeLead, closeRoundFor, resolveProduct } from "../lib/import/attribute";
import { planImport, ImportError } from "../lib/import/pipeline";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `\n       got ${JSON.stringify(a)}\n       want ${JSON.stringify(b)}`);

console.log("\nCSV");
{
  const csv = 'Day,Ad set name,"Amount spent (SGD)",Impressions\n2026-05-14,"Cold_Broad, 25-45","1,378.24",30257\n';
  const { headers, rows } = parseCsv(csv);
  eq("headers", headers, ["Day", "Ad set name", "Amount spent (SGD)", "Impressions"]);
  eq("quoted comma survives", rows[0]["Ad set name"], "Cold_Broad, 25-45");
  eq("thousands separator", toNumber(rows[0]["Amount spent (SGD)"]), 1378.24);

  const multi = parseCsv('a,b\n"line one\nline two",2\n');
  eq("embedded newline", multi.rows[0].a, "line one\nline two");
  eq("escaped quotes", parseCsv('a\n"say ""hi"""\n').rows[0].a, 'say "hi"');
  eq("BOM stripped", parseCsv('﻿a,b\n1,2\n').headers[0], "a");
  eq("day-first dates", toDate("05/06/2026"), "2026-06-05");
  eq("negative in parens", toNumber("(45.00)"), -45);
}

console.log("\nColumn mapping");
{
  const headers = ["Day", "Ad set name", "Amount spent (SGD)", "Impressions", "Reach", "Outbound clicks"];
  const { map, missing } = mapColumns("ads", headers);
  eq("maps aliases", map.spend, "Amount spent (SGD)");
  eq("nothing missing", missing, []);

  // Meta renames the spend column — this must break loudly
  const renamed = mapColumns("ads", ["Day", "Ad set name", "Impressions"], map);
  ok("renamed required column is reported missing", renamed.missing.includes("spend"));
  ok("rename is described", renamed.broken.some((b) => b.includes("Amount spent")));

  // remembered mapping wins over alias guessing
  const remembered = mapColumns("ads", headers, { spend: "Amount spent (SGD)", date: "Day" });
  eq("remembered mapping reused", remembered.map.date, "Day");
}

console.log("\nIdentity");
{
  eq("email lowercased/trimmed", normEmail("  MeiLin.W@Gmail.com "), "meilin.w@gmail.com");
  eq("plus alias stripped", stripPlus("meilin.w+2@gmail.com"), "meilin.w@gmail.com");
  eq("SG phone to E.164", normPhone("+65 9123 4567"), "+6591234567");
  eq("bare 8-digit SG", normPhone("91234567"), "+6591234567");
  eq("unparseable phone stays null", normPhone("n/a"), null);

  const index = buildIndex([
    { contact_id: "c1", email: "meilin.w@gmail.com", phone: "+6591234567" , client_id: "shely" },
    { contact_id: "c2", email: "j.tan@gmail.com", phone: null , client_id: "shely" },
  ]);

  eq("exact email", matchRow(index, "meilin.w@gmail.com", null, false).kind, "exact");
  const plus = matchRow(index, "meilin.w+2@gmail.com", null, false);
  eq("plus-addressed auto-resolves", plus.kind, "auto");
  eq("auto to the same person", (plus as any).contactId, "c1");
  const phone = matchRow(index, null, "+65 9123 4567", false);
  eq("reformatted phone is exact once normalised", phone.kind, "exact");

  const nameOnly = matchRow(index, null, null, false);
  eq("name-only parks", nameOnly.kind, "park");
  eq("name-only offers nothing", (nameOnly as any).bestGuess, null);

  eq("unknown buyer parks, never invented", matchRow(index, "raj@nowhere.sg", null, false).kind, "park");
  eq("unknown lead creates a contact", matchRow(index, "raj@nowhere.sg", null, true).kind, "new");
}

console.log("\nAttribution");
{
  const rounds = [
    { round_id: "0526-02", client_id: "shely", start_date: "2026-05-13", end_date: "2026-05-19", session_date: "2026-05-19" },
    { round_id: "0526-03", client_id: "shely", start_date: "2026-05-23", end_date: "2026-05-27", session_date: "2026-05-27" },
  ];
  const runs = [
    { ad_set: "Cold_Broad", round_id: "0526-02", date: "2026-05-14" },
    { ad_set: "Cold_Broad", round_id: "0526-03", date: "2026-05-24" },
  ];

  const utm = attributeLead("2026-05-24T09:00:00Z", "Cold_Broad", rounds, runs);
  eq("utm picks the round the ad set ran in", [utm.roundId, utm.method], ["0526-03", "utm"]);

  const win = attributeLead("2026-05-14T09:00:00Z", null, rounds, runs);
  eq("no utm falls back to date window", [win.roundId, win.method], ["0526-02", "date_window"]);

  const gap = attributeLead("2026-05-21T09:00:00Z", null, rounds, runs);
  eq("between rounds attributes to the last open one, still date_window", [gap.roundId, gap.method], ["0526-02", "date_window"]);

  eq("close round is the most recent attendance before purchase",
    closeRoundFor("2026-05-27T22:00:00Z", [
      { round_id: "0526-02", event_date: "2026-05-19T20:00:00Z" },
      { round_id: "0526-03", event_date: "2026-05-27T20:00:00Z" },
    ]), "0526-03");
  eq("attendance after the purchase is ignored",
    closeRoundFor("2026-05-20T10:00:00Z", [
      { round_id: "0526-02", event_date: "2026-05-19T20:00:00Z" },
      { round_id: "0526-03", event_date: "2026-05-27T20:00:00Z" },
    ]), "0526-02");
  eq("no attendance means no close round", closeRoundFor("2026-05-20T10:00:00Z", []), null);

  eq("product preview", resolveProduct("2-hour preview workshop"), "preview");
  eq("product middle", resolveProduct("2-Day Middle Funnel Workshop"), "middle");
  eq("unknown product", resolveProduct("t-shirt"), null);
}

// ── fake database ──────────────────────────────────────────────────────────
type Tables = Record<string, any[]>;
function fakeDb(tables: Tables) {
  const build = (rows: any[]) => {
    let out = [...rows];
    const api: any = {
      select: () => api,
      eq: (c: string, v: any) => { out = out.filter((r) => r[c] === v); return api; },
      in: (c: string, v: any[]) => { out = out.filter((r) => v.includes(r[c])); return api; },
      not: (c: string, _op: string, _v: any) => { out = out.filter((r) => r[c] != null); return api; },
      range: (from: number, to: number) => { out = out.slice(from, to + 1); return api; },
      order: () => api,
      maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
      single: async () => ({ data: out[0] ?? null, error: null }),
      then: (res: any) => Promise.resolve({ data: out, error: null }).then(res),
    };
    return api;
  };
  return { from: (t: string) => build(tables[t] ?? []) } as any;
}

const ROUNDS = [
  { round_id: "0526-02", client_id: "shely", start_date: "2026-05-13", end_date: "2026-05-19", session_date: "2026-05-19" },
  { round_id: "0526-03", client_id: "shely", start_date: "2026-05-23", end_date: "2026-05-27", session_date: "2026-05-27" },
];

console.log("\nPipeline — leads");
{
  const db = fakeDb({
    rounds: ROUNDS,
    contacts: [{ contact_id: "c1", email: "known@example.sg", phone: null , client_id: "shely" }],
    events: [],
    ads_performance: [{ ad_set: "Cold_Broad", round_id: "0526-02", date: "2026-05-14" }],
    v_column_map: [],
  });
  const csv = [
    "Email,Phone,Created,utm_campaign",
    "known@example.sg,,2026-05-14,Cold_Broad",       // exact match, utm
    "fresh@example.sg,91234567,2026-05-15,",          // new contact, date window
    ",,2026-05-15,",                                  // name only -> parked
  ].join("\n");

  const plan = await planImport(db, { source: "leads", clientId: "shely", fileName: "leads.csv", text: csv });
  eq("exact match counted", plan.counts.matchedExact, 1);
  eq("new contact created", plan.counts.newContacts, 1);
  eq("nameless row parked", plan.counts.parked, 1);
  eq("one attributed by utm", plan.attribution.utm, 1);
  eq("one attributed by date window", plan.attribution.dateWindow, 1);
  eq("two lead events staged", plan.ops.events.length, 2);
  eq("method stored on the row", plan.ops.events[0].attribution_method, "utm");
  eq("utm lead is Paid Ads", plan.ops.events[0].source, "Paid Ads");
  eq("non-utm lead is Organic", plan.ops.events[1].source, "Organic");
  ok("nothing written during planning", plan.ops.events.every((e) => e.event_id));
}

console.log("\nPipeline — sales");
{
  const db = fakeDb({
    rounds: ROUNDS,
    contacts: [
      { contact_id: "c1", email: "buyer@example.sg", phone: null , client_id: "shely" },
      { contact_id: "c2", email: "nolead@example.sg", phone: null , client_id: "shely" },
    ],
    events: [
      { event_id: "e1", contact_id: "c1", round_id: "0526-02", event_type: "lead", event_date: "2026-05-14T09:00:00Z", lead_round_id: "0526-02", source: "Paid Ads", product: null, amount: null, refund_amount: null },
      { event_id: "e2", contact_id: "c1", round_id: "0526-03", event_type: "attendance", event_date: "2026-05-27T20:00:00Z", lead_round_id: "0526-02", source: "Paid Ads", product: null, amount: null, refund_amount: null },
    ],
    ads_performance: [],
    v_column_map: [],
  });
  const csv = [
    "Date,Email,Product,Amount,Refunded",
    "2026-05-27,buyer@example.sg,2-hour preview workshop,297,0",
    "2026-05-27,nolead@example.sg,2-hour preview workshop,297,0",
    "2026-05-27,ghost@example.sg,2-hour preview workshop,297,0",
  ].join("\n");

  const plan = await planImport(db, { source: "sales", clientId: "shely", fileName: "sales.csv", text: csv });
  const sale = plan.ops.events[0];
  eq("revenue credited to the lead round", sale.lead_round_id, "0526-02");
  eq("closing credited to the class attended", sale.close_round_id, "0526-03");
  eq("counted in ROAS", sale.is_lead, true);

  const noLead = plan.ops.events[1];
  eq("known buyer with no lead is still revenue", noLead.product, "preview");
  eq("but excluded from ROAS", noLead.is_lead, false);

  eq("unknown buyer parked", plan.counts.parked, 1);
  eq("their revenue is held, not credited", plan.ops.unmatched[0].revenue_held, 297);
}

console.log("\nPipeline — refunds restate");
{
  const db = fakeDb({
    rounds: ROUNDS,
    contacts: [{ contact_id: "c1", email: "buyer@example.sg", phone: null , client_id: "shely" }],
    events: [
      { event_id: "e1", contact_id: "c1", round_id: "0526-02", event_type: "lead", event_date: "2026-05-14T09:00:00Z", lead_round_id: "0526-02", source: "Paid Ads", product: null, amount: null, refund_amount: null },
      { event_id: "s1", contact_id: "c1", round_id: "0526-02", event_type: "sale", event_date: "2026-05-19T21:00:00Z", lead_round_id: "0526-02", source: "Paid Ads", product: "preview", amount: "297", refund_amount: "0" },
    ],
    ads_performance: [],
    v_column_map: [],
  });
  const csv = [
    "Date,Email,Product,Amount,Refunded,Refunded at",
    "2026-05-19,buyer@example.sg,2-hour preview workshop,297,297,2026-06-02",
  ].join("\n");

  const plan = await planImport(db, { source: "sales", clientId: "shely", fileName: "refunds.csv", text: csv });
  eq("no new row, it is a change", plan.diff.newRows, 0);
  eq("one changed row", plan.diff.changedRows, 1);
  ok("restatement is warned about", plan.diff.restatements.some((r) => r.includes("0526-02") && r.includes("restate")));
  eq("refund carries its date", plan.ops.refundUpdates[0].refund_date, "2026-06-02");
}

console.log("\nPipeline — refuses a broken mapping");
{
  const db = fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] });
  let threw: ImportError | null = null;
  try {
    await planImport(db, { source: "sales", clientId: "shely", fileName: "bad.csv", text: "Date,Email\n2026-05-19,a@b.sg" });
  } catch (e) { threw = e as ImportError; }
  ok("import refused", threw instanceof ImportError);
  ok("names the missing fields", (threw?.detail ?? []).some((d) => d.includes("product") || d.includes("amount")));
}

console.log("\nPipeline — idempotent re-import");
{
  const existing = [
    { event_id: "e1", contact_id: "c1", round_id: "0526-02", event_type: "lead", event_date: "2026-05-14T09:00:00Z", lead_round_id: "0526-02", source: "Paid Ads", product: null, amount: null, refund_amount: null },
  ];
  const db = fakeDb({
    rounds: ROUNDS,
    contacts: [{ contact_id: "c1", email: "known@example.sg", phone: null , client_id: "shely" }],
    events: existing,
    ads_performance: [],
    v_column_map: [],
  });
  const csv = "Email,Phone,Created,utm_campaign\nknown@example.sg,,2026-05-14,\n";
  const plan = await planImport(db, { source: "leads", clientId: "shely", fileName: "again.csv", text: csv });
  eq("re-importing the same row writes nothing", plan.ops.events.length, 0);
  eq("it is reported as already present", plan.counts.duplicates, 1);
}

/**
 * The downloadable templates are a promise: "fill this in and it will import."
 * Each one is checked against the real mapper, so the promise can't rot when a
 * field is added to SOURCES and the example table isn't updated to match.
 */
console.log("\nTemplates");
{
  for (const source of ["ads", "leads", "attendance", "sales"] as const) {
    const { headers, rows } = parseCsv(buildTemplate(source));
    const { missing, unused } = mapColumns(source, headers);
    eq(`${source}: every required field maps`, missing, []);
    eq(`${source}: no stray columns`, unused, []);
    eq(`${source}: the "#" legend is not read as data`, rows.length, 2);
    ok(
      `${source}: example rows fill every required field`,
      SOURCES[source].fields
        .filter((f) => f.required)
        .every((f) => rows.every((r) => (r[f.field] ?? "").trim() !== "")),
    );
  }
  // Every date in an example row has to survive the real converters, or the
  // template teaches a format the importer would reject.
  for (const source of ["ads", "leads", "attendance", "sales"] as const) {
    const { rows } = parseCsv(buildTemplate(source));
    for (const field of ["date", "event_date"]) {
      const values = rows.map((r) => r[field]).filter((v) => v);
      if (!values.length) continue;
      ok(`${source}: example ${field} parses`, values.every((v) => toDate(v) !== null));
    }
  }
  // Attendance advises a timestamp over a bare date because it decides the
  // closing credit — so the example must actually carry one.
  const att = parseCsv(buildTemplate("attendance")).rows[0]["event_date"];
  ok("attendance example carries a time, as its own note advises", /\d:\d/.test(att));

  // A hash in the first cell is what makes the legend skippable; prove it is
  // scoped to that position and doesn't eat a real value elsewhere.
  const withHash = parseCsv("email,note\na@b.sg,#1 priority\n");
  eq("a hash inside a row is kept", withHash.rows[0]["note"], "#1 priority");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
