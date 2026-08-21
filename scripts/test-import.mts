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

import { parseCsv, writeCsv, toNumber, toDate, toTimestamp, localDay } from "../lib/import/csv";
import { mapColumns, SOURCES } from "../lib/import/sources";
import { buildTemplate } from "../lib/import/template";
import { buildIndex, matchRow, normPhone, normEmail, stripPlus } from "../lib/import/identity";
import { attributeLead, closeRoundFor, resolveProduct, roundFromCampaign, resolveRoundRef } from "../lib/import/attribute";
import { planImport, commitPlan, ImportError, roundForWindow } from "../lib/import/pipeline";
import { parseClarityScroll, ClarityError, sessionsFrom, deviceFromName } from "../lib/import/clarity";
import {
  curveOf, biggestDrop, ceilingOf, coverageOf, runsFor, type ScrollRun,
} from "../lib/funnel/scroll";
import { cadencesFor, resolveSpine } from "../lib/funnel/cadence";
import {
  niceMax, axisMax, num, chartModel, lineRuns, colX, valueY, floorY, ticksFor, TICKS, GEO,
  colWidth, chartWidth, labelChars, wrapLabel, VS_OPTIONS, vsOption, isVs, DEFAULT_OPTS,
} from "../lib/funnel/chart";
import {
  compare, movesFor, issuesIn, tooThinIn, missedTargetIn, diffAssets, candidatesFrom,
  roundProgress, moveChip, MIN_SAMPLE,
} from "../lib/funnel/analysis";

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

  // Resolving a parked row replays it as CSV, so writeCsv has to survive
  // everything parseCsv was careful about. A join(",") here would corrupt on
  // the way out the exact values that were protected on the way in.
  const nasty = { a: 'Cold_Broad, 25-45', b: 'say "hi"', c: "line one\nline two", d: "" };
  const back = parseCsv(writeCsv(Object.keys(nasty), [nasty])).rows[0];
  eq("csv round-trips a comma", back.a, nasty.a);
  eq("csv round-trips a quote", back.b, nasty.b);
  eq("csv round-trips a newline", back.c, nasty.c);
  eq("csv round-trips a blank", back.d, "");
}

// Every export here is written in UTC+8 and the server is not. A time with no
// zone on it moved an 8pm webinar to 4am the next morning, which silently costs
// a class its closing credit — so these are the tests that must not regress.
console.log("\nTime zone");
{
  // Zoom writes the meeting's local clock with no offset at all
  eq("zoom time is read as UTC+8", toTimestamp("05/19/2026 07:32:09 PM"), "2026-05-19T11:32:09.000Z");
  eq("24h local time", toTimestamp("2026-08-05 20:04"), "2026-08-05T12:04:00.000Z");
  eq("midnight is not noon", toTimestamp("05/19/2026 12:15:00 AM"), "2026-05-18T16:15:00.000Z");
  eq("noon is not midnight", toTimestamp("05/19/2026 12:15:00 PM"), "2026-05-19T04:15:00.000Z");

  // an explicit offset is the file telling us; never second-guess it
  eq("GHL offset is trusted", toTimestamp("2026-05-19T00:00:24+08:00"), "2026-05-18T16:00:24.000Z");
  eq("Z is trusted", toTimestamp("2026-05-19T09:00:00Z"), "2026-05-19T09:00:00.000Z");

  // date with no time = end of the LOCAL day, so a same-day sale still lands
  // after the class that closed it
  eq("date only is end of the SG day", toTimestamp("2026-05-19"), "2026-05-19T15:59:59.000Z");

  // one slash rule for dates and timestamps alike
  eq("19 can't be a month, so month-first", toDate("05/19/2026"), "2026-05-19");
  eq("19 first means day-first", toDate("19/05/2026"), "2026-05-19");
  eq("ambiguous stays day-first", toDate("05/06/2026"), "2026-06-05");
  eq("timestamp uses the same rule as the date", toTimestamp("05/06/2026 10:00")?.slice(0, 10), "2026-06-05");
  eq("impossible date is refused, not coerced", toDate("19/19/2026"), null);

  eq("junk is null, not epoch", toTimestamp("No data available."), null);

  // Instants are stored in UTC and bucketed by the LOCAL day. A 4am opt-in on
  // the 23rd is a 23rd opt-in, even though its UTC day is the 22nd — and round
  // windows are local calendar dates, so that is the clock they must share.
  eq("early morning keeps its local day", localDay("2026-05-22T19:56:17Z"), "2026-05-23");
  eq("late evening keeps its local day", localDay("2026-05-23T15:00:00Z"), "2026-05-23");
  eq("just before local midnight", localDay("2026-05-23T15:59:59Z"), "2026-05-23");
  eq("just after local midnight", localDay("2026-05-23T16:00:00Z"), "2026-05-24");

  // the bug this actually caused: nine leads filed into the previous round
  const rounds = [
    { round_id: "0526-02", client_id: "shely", start_date: "2026-05-13", end_date: "2026-05-19", session_dates: ["2026-05-19"] },
    { round_id: "0526-03", client_id: "shely", start_date: "2026-05-23", end_date: "2026-05-27", session_dates: ["2026-05-27"] },
  ];
  const dawn = attributeLead(toTimestamp("2026-05-23 03:56:17")!, null, rounds, []);
  eq("a 4am opt-in belongs to the round that opened that morning", dawn.roundId, "0526-03");
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
    { round_id: "0526-02", client_id: "shely", start_date: "2026-05-13", end_date: "2026-05-19", session_dates: ["2026-05-19"] },
    { round_id: "0526-03", client_id: "shely", start_date: "2026-05-23", end_date: "2026-05-27", session_dates: ["2026-05-27"] },
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
      is: (c: string, v: any) => { out = out.filter((r) => (r[c] ?? null) === v); return api; },
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

/**
 * A fake that also WRITES. The read-only one above cannot reach commitPlan, and
 * that gap let a real bug through: re-importing a source left the previous
 * upload's parked rows in the queue, so the same eight people were counted
 * twice and "revenue held" nearly doubled. Every rule the plan gets right can
 * still be undone on the way to disk.
 */
function writableDb(tables: Tables) {
  const build = (name: string) => {
    const all = (tables[name] ??= []);
    let out = [...all];
    let pending: any = null;
    const api: any = {
      select: () => api,
      insert: async (rows: any) => { all.push(...(Array.isArray(rows) ? rows : [rows])); return { error: null }; },
      update: (patch: any) => { pending = patch; return api; },
      // A scroll re-import replaces the curve it supersedes rather than
      // upserting it, so the writable fake has to be able to delete or that
      // path is never exercised. `depths` follow through ON DELETE CASCADE in
      // Postgres; here the cascade is spelled out.
      delete: () => { pending = "delete"; return api; },
      eq:   (c: string, v: any) => { out = out.filter((r) => r[c] === v); return api; },
      neq:  (c: string, v: any) => { out = out.filter((r) => r[c] !== v); return api; },
      in:   (c: string, v: any[]) => { out = out.filter((r) => v.includes(r[c])); return api; },
      not:  (c: string) => { out = out.filter((r) => r[c] != null); return api; },
      is:   (c: string, v: any) => { out = out.filter((r) => (r[c] ?? null) === v); return api; },
      order: () => api,
      range: (f: number, t: number) => { out = out.slice(f, t + 1); return api; },
      maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
      single: async () => ({ data: out[0] ?? null, error: null }),
      then: (res: any) => {
        if (pending === "delete") {
          const gone = new Set(out);
          const kept = all.filter((r) => !gone.has(r));
          all.length = 0; all.push(...kept);
          if (name === "scroll_runs") {
            const ids = new Set(out.map((r) => r.run_id));
            const d = (tables.scroll_depths ??= []);
            const keep = d.filter((r: any) => !ids.has(r.run_id));
            d.length = 0; d.push(...keep);
          }
        } else if (pending) out.forEach((r) => Object.assign(r, pending));
        return Promise.resolve({ data: out, error: null }).then(res);
      },
    };
    return api;
  };
  return { from: build } as any;
}

const ROUNDS = [
  { round_id: "0526-02", client_id: "shely", start_date: "2026-05-13", end_date: "2026-05-19", session_dates: ["2026-05-19"] },
  { round_id: "0526-03", client_id: "shely", start_date: "2026-05-23", end_date: "2026-05-27", session_dates: ["2026-05-27"] },
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

// GoHighLevel writes three tracking tags and they mean three different things.
// The app used to read one column called utm_campaign and expect the AUDIENCE in
// it — so a raw GHL export imported perfectly and attributed nothing, because
// every lead arrived carrying a round name where an ad set was expected. The only
// reason the numbers were right was a hand-edited file.
console.log("\nLeads — a raw GoHighLevel export attributes correctly");
{
  const ROUND_ADS = [{ ad_set: "Cold_Broad", round_id: "0526-02", date: "2026-05-14" }];
  const db = () => fakeDb({
    rounds: ROUNDS, contacts: [], events: [], ads_performance: ROUND_ADS, v_column_map: [],
  });

  // exactly what GHL exports, untouched
  const raw = await planImport(db(), {
    source: "leads", clientId: "shely", fileName: "ghl.csv",
    text: [
      "Email,Phone,Created,utm_medium,utm_content,utm_source,utm_term,utm_campaign",
      "a@example.sg,,2026-05-14,df,Static_LetAISell,META,Cold_Broad,DF_SG_Preview_Sprint1_0526_02",
    ].join("\n"),
  });
  const lead = raw.ops.events[0];
  eq("the audience comes from utm_term", lead.ad_set, "Cold_Broad");
  eq("the ad comes from utm_content", lead.ad, "Static_LetAISell");
  eq("utm_campaign stays the round's campaign", lead.utm_campaign, "DF_SG_Preview_Sprint1_0526_02");
  eq("so attribution is known, not inferred", lead.attribution_method, "utm");
  eq("and it is Paid Ads", lead.source, "Paid Ads");

  // files built before this change put the audience in a column called
  // utm_campaign — they must keep working, so utm_campaign is the last alias
  const legacy = await planImport(db(), {
    source: "leads", clientId: "shely", fileName: "leads.csv",
    text: ["email,phone,event_date,source,utm_campaign", "b@example.sg,,2026-05-14,Paid Ads,Cold_Broad"].join("\n"),
  });
  eq("an older file still finds its audience", legacy.ops.events[0].ad_set, "Cold_Broad");
  eq("and is still attributed by utm", legacy.ops.events[0].attribution_method, "utm");

  // a lead with no audience at all is organic and stays out of every audience column
  const none = await planImport(db(), {
    source: "leads", clientId: "shely", fileName: "x.csv",
    text: ["email,event_date", "c@example.sg,2026-05-14"].join("\n"),
  });
  eq("no audience means no ad set", none.ops.events[0].ad_set, null);
  eq("and organic, attributed by date window", none.ops.events[0].source, "Organic");
  eq("...which is recorded as such", none.ops.events[0].attribution_method, "date_window");

  // 17 real leads carry a raw Meta Ad ID in utm_content instead of a name
  const byId = await planImport(db(), {
    source: "leads", clientId: "shely", fileName: "ghl.csv",
    text: ["Email,Created,utm_term,utm_content", "d@example.sg,2026-05-14,Cold_Broad,120249101765580425"].join("\n"),
  });
  eq("an Ad ID in utm_content is kept as-is", byId.ops.events[0].ad, "120249101765580425");
}

// A Meta ad-set export has no clicks column at all. Storing the blank as 0 made
// every audience read "Outbound CTR 0.00%" and "Reach 0" — measurements, both
// false. Null sums away, so a round total built from one row that HAS clicks and
// sixty that don't still comes to the right number.
console.log("\nAds — a blank count is absent, not zero");
{
  const db = fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] });
  const plan = await planImport(db, {
    source: "ads", clientId: "shely", fileName: "adsets.csv",
    text: [
      "date,ad_set,spend,impressions,reach,clicks",
      "2026-05-15,Cold_Broad,273.90,5237,,",          // the export gave no reach or clicks
      "2026-05-15,,84.20,1566,12672,479",             // the round-level correction row
      "2026-05-16,Cold_Broad,0,0,,",                  // Meta writes an explicit 0 for spend
    ].join("\n"),
  });
  eq("a blank clicks cell stays absent", plan.ops.ads[0].clicks, null);
  eq("a blank reach cell stays absent", plan.ops.ads[0].reach, null);
  eq("a stated impressions figure is kept", plan.ops.ads[0].impressions, 5237);
  eq("a stated clicks figure is kept", plan.ops.ads[1].clicks, 479);
  eq("spend 0 is a measurement and stays 0", plan.ops.ads[2].spend, 0);
  eq("an explicit 0 impressions stays 0", plan.ops.ads[2].impressions, 0);
}

// A campaign-level Meta export has no ad set and no ad name, so every campaign
// running on the same day used to collapse to one dedupe key and all but the
// first were counted as duplicates. On a real 75-row export that landed 10 rows,
// discarded 50, and reported a round's spend as 0.00 — a wrong number produced
// by the code path whose entire job is to stop double-counting.
console.log("\nAds — two campaigns on one day are two rows, not a duplicate");
{
  const db = fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] });
  const plan = await planImport(db, {
    source: "ads", clientId: "shely", fileName: "campaigns.csv",
    text: [
      "Reporting starts,Campaign name,Amount spent (SGD),Impressions,Reach",
      "2026-05-15,DF_SG_Preview_Sprint1_0526_02,273.90,5237,3574",
      "2026-05-15,DF_SG_Preview_Sprint1AI_0526_02,84.20,1566,900",
      "2026-05-15,Dormant campaign,0,0,0",
    ].join("\n"),
  });
  eq("all three campaigns are kept", plan.ops.ads.length, 3);
  eq("none is mistaken for a repeat", plan.counts.duplicates, 0);
  eq("the spend is the sum, not the first row",
     Number(plan.ops.ads.reduce((s, a) => s + Number(a.spend), 0).toFixed(2)), 358.1);
  eq("the campaign name is stored", plan.ops.ads[1].campaign, "DF_SG_Preview_Sprint1AI_0526_02");

  // re-uploading the same file must still be a no-op
  const again = await planImport(fakeDb({
    rounds: ROUNDS, contacts: [], events: [], v_column_map: [],
    ads_performance: plan.ops.ads.map((a) => ({ ...a })),
  }), {
    source: "ads", clientId: "shely", fileName: "campaigns.csv",
    text: [
      "Reporting starts,Campaign name,Amount spent (SGD),Impressions,Reach",
      "2026-05-15,DF_SG_Preview_Sprint1_0526_02,273.90,5237,3574",
      "2026-05-15,DF_SG_Preview_Sprint1AI_0526_02,84.20,1566,900",
      "2026-05-15,Dormant campaign,0,0,0",
    ].join("\n"),
  });
  eq("re-uploading the same campaigns writes nothing", again.ops.ads.length, 0);
  eq("...and says all three were seen before", again.counts.duplicates, 3);
}

// A buyer with a phone and no email is ordinary in a payments export, and the
// same normalisation runs on both, so matching on one is as sound as the other.
// Before this, those rows could only ever park.
console.log("\nPhone is an identity in sales and attendance too");
{
  const KNOWN = { contact_id: "c9", email: null, phone: "+60122157534", client_id: "shely" };
  const mk = (extra: any[] = []) => fakeDb({
    rounds: ROUNDS, contacts: [KNOWN], ads_performance: [], v_column_map: [],
    events: [{ event_id: "l9", contact_id: "c9", round_id: "0526-02", event_type: "lead",
      event_date: "2026-05-14T02:00:00.000Z", product: null, amount: null, refund_amount: null,
      lead_round_id: "0526-02", source: "Paid Ads" }, ...extra],
  });

  eq("sales takes a phone column", SOURCES.sales.fields.some((f) => f.field === "phone"), true);
  eq("attendance takes one too", SOURCES.attendance.fields.some((f) => f.field === "phone"), true);

  const sale = await planImport(mk(), {
    source: "sales", clientId: "shely", fileName: "s.csv",
    text: "event_date,email,phone,product,amount\n2026-05-20,,60122157534,Preview Offer,297",
  });
  eq("a buyer with no email still matches on their number", sale.counts.matchedExact, 1);
  eq("and the sale is written, not held", sale.ops.events.length, 1);
  eq("it belongs to the round that produced the lead", sale.ops.events[0].lead_round_id, "0526-02");

  const att = await planImport(mk(), {
    source: "attendance", clientId: "shely", fileName: "a.csv",
    text: "round_id,email,phone\n0526-02,,+6012 215 7534",
  });
  eq("attendance matches a reformatted number", att.ops.events.length, 1);

  // Re-uploading a file that was FIXED must not leave the old parked row
  // holding revenue the app has just started counting.
  const rawParked = { event_date: "2026-05-20", email: "", phone: "60122157534",
    product: "Preview Offer", amount: "297" };
  const withQueue = fakeDb({
    rounds: ROUNDS, contacts: [KNOWN], ads_performance: [], v_column_map: [],
    events: [{ event_id: "l9", contact_id: "c9", round_id: "0526-02", event_type: "lead",
      event_date: "2026-05-14T02:00:00.000Z", product: null, amount: null, refund_amount: null,
      lead_round_id: "0526-02", source: "Paid Ads" }],
    unmatched_rows: [{ row_id: "u1", client_id: "shely", source: "sales",
      raw_data: rawParked, resolved_at: null, revenue_held: 297 }],
  });
  const again = await planImport(withQueue, {
    source: "sales", clientId: "shely", fileName: "s.csv",
    text: "event_date,email,phone,product,amount\n2026-05-20,,60122157534,Preview Offer,297",
  });
  eq("the sale is now countable", again.ops.events.length, 1);
  eq("and its parked row is retired, not left holding the same money",
     again.ops.supersededParked, [{ row_id: "u1", contact_id: "c9" }]);
}

// Resolving a parked row used to stamp resolved_at and stop, so an accepted
// sale left the queue, dropped out of "revenue held", and was still counted
// nowhere — 297 of real money quietly stopped being tracked. Resolution now
// replays the row through this same pipeline with the identity supplied, so it
// has to produce exactly the event an ordinary import would have.
console.log("\nUnmatched — resolving replays the real import");
{
  const ATTENDED = { event_id: "e1", contact_id: "c1", round_id: "0526-02", event_type: "attendance",
    event_date: "2026-05-19T12:00:00.000Z", product: null, amount: null, refund_amount: null,
    lead_round_id: "0526-02", source: "Paid Ads" };
  const LEAD = { event_id: "e0", contact_id: "c1", round_id: "0526-02", event_type: "lead",
    event_date: "2026-05-14T02:00:00.000Z", product: null, amount: null, refund_amount: null,
    lead_round_id: "0526-02", source: "Paid Ads" };
  const db = () => fakeDb({
    rounds: ROUNDS,
    contacts: [{ contact_id: "c1", email: "known@example.sg", phone: null, client_id: "shely" }],
    events: [LEAD, ATTENDED],
    ads_performance: [],
    v_column_map: [],
  });

  // the parked row exactly as it sat in the queue: no email in the export
  const parked = "event_date,email,product,amount,name\n2026-05-20,,Preview Offer,297,Someone";

  const asIs = await planImport(db(), { source: "sales", clientId: "shely", fileName: "r.csv", text: parked });
  eq("without an identity it parks, as it did on import", asIs.counts.parked, 1);
  eq("and holds the money", asIs.ops.unmatched[0].revenue_held, 297);

  const resolved = await planImport(db(), {
    source: "sales", clientId: "shely", fileName: "r.csv", text: parked, asContactId: "c1",
  });
  eq("naming the person produces the event", resolved.ops.events.length, 1);
  eq("nothing is left parked", resolved.counts.parked, 0);
  eq("the money is real now, not held", resolved.ops.events[0].amount, 297);
  // the whole reason to replay rather than just stamp the row: attribution
  eq("revenue lands on the round that produced the lead", resolved.ops.events[0].lead_round_id, "0526-02");
  eq("closing credit goes to the class actually attended", resolved.ops.events[0].close_round_id, "0526-02");
  eq("it counts as a lead-backed sale", resolved.ops.events[0].is_lead, true);

  // resolving the same row twice must not double-count the money
  const already = await planImport(db2(), {
    source: "sales", clientId: "shely", fileName: "r.csv", text: parked, asContactId: "c1",
  });
  eq("a sale already imported is a duplicate, not a second 297", already.ops.events.length, 0);
  eq("...and is reported as such", already.counts.duplicates, 1);

  function db2() {
    return fakeDb({
      rounds: ROUNDS,
      contacts: [{ contact_id: "c1", email: "known@example.sg", phone: null, client_id: "shely" }],
      events: [LEAD, ATTENDED, { event_id: "e2", contact_id: "c1", round_id: "0526-02", event_type: "sale",
        event_date: "2026-05-20T15:59:59.000Z", product: "preview", amount: 297, refund_amount: 0,
        lead_round_id: "0526-02", source: "Paid Ads" }],
      ads_performance: [],
      v_column_map: [],
    });
  }

  // naming the person does not fix a row that was ALSO missing something else
  const stillBroken = await planImport(db(), {
    source: "sales", clientId: "shely", fileName: "r.csv", asContactId: "c1",
    text: "event_date,email,product,amount,name\n,,Preview Offer,297,Someone",
  });
  eq("a row with no date stays parked even once the person is known", stillBroken.ops.events.length, 0);
  eq("and says what is still wrong", stillBroken.ops.unmatched[0].guess_method, "missing date or amount");
}

// "Name only, no contact detail" was grouping rows that had contact detail —
// a lead with an email but no opt-in date was filed under "no contact detail"
// with its address right there in the row. Four problems, four fixes, four
// reasons.
console.log("\nPipeline — a parked row says why it was parked");
{
  const db = fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] });

  const leads = await planImport(db, {
    source: "leads", clientId: "shely", fileName: "leads.csv",
    text: ["Email,Created", "dated@example.sg,2026-05-14", "nodate@example.sg,", ",2026-05-14"].join("\n"),
  });
  const by = (reason: string) => leads.ops.unmatched.filter((u) => u.reason === reason);
  eq("an email with no date is an incomplete row", by("incomplete_row").length, 1);
  eq("...and it is NOT filed as having no contact detail", by("name_only").length, 1);
  eq("the row with no contact detail still is", by("name_only")[0].guess_method, null);
  eq("the incomplete row says what is missing", by("incomplete_row")[0].guess_method, "no usable opt-in date");

  // A stranger in an attendance file is a stranger, not a buyer. matchRow used
  // to call every unmatched-but-contactable row "bought_without_lead" whatever
  // file it came from, so a Zoom export with real emails would have filled the
  // queue with people who bought nothing.
  const att = await planImport(db, {
    source: "attendance", clientId: "shely", fileName: "att.csv",
    text: ["Session,Email", "0526-02,stranger@example.sg"].join("\n"),
  });
  eq("a stranger who attended did not buy anything",
     att.ops.unmatched.map((u) => u.reason), ["unknown_person"]);

  const sale = await planImport(db, {
    source: "sales", clientId: "shely", fileName: "sales.csv",
    text: ["event_date,email,product,amount", "2026-05-20,stranger@example.sg,Preview Offer,297"].join("\n"),
  });
  eq("...but a stranger who paid is revenue with no lead behind it",
     sale.ops.unmatched.map((u) => u.reason), ["bought_without_lead"]);
  eq("and the money is held", sale.ops.unmatched[0].revenue_held, 297);
}

// An empty cell is absent, not an empty value. A Meta export with a blank Ad set
// name wrote ad_set = '' — not null — so Targeted views grew an audience whose
// name was the empty string: a column with no header holding every dollar.
console.log("\nPipeline — a blank cell is null, not \"\"");
{
  const db = fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] });
  const csv = [
    "date,campaign,ad set name,ad,spend,impressions,reach,clicks",
    "2026-05-14,,,,1378.24,30257,12672,479",
    "2026-05-24, , , ,1153.22,22669,10131,377",   // whitespace is just as blank
  ].join("\n");

  const plan = await planImport(db, { source: "ads", clientId: "shely", fileName: "ads.csv", text: csv });
  eq("both ads rows staged", plan.ops.ads.length, 2);
  eq("blank ad set is null", plan.ops.ads[0].ad_set, null);
  eq("whitespace ad set is null", plan.ops.ads[1].ad_set, null);
  eq("blank campaign is null", plan.ops.ads[0].campaign, null);
  eq("spend still read", plan.ops.ads[0].spend, 1378.24);
  eq("the two rounds are still told apart", [plan.ops.ads[0].round_id, plan.ops.ads[1].round_id], ["0526-02", "0526-03"]);
  // both rows key on `round|date|''|''` only because the nulls collapse the same
  // way — they must still not be seen as duplicates of each other
  eq("distinct rows are not deduped", plan.counts.duplicates, 0);
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
      // 8pm SG, which is 12:00Z. Written as 20:00Z this test used to pass for
      // the wrong reason: the sale's date-only timestamp was landing at 23:59Z
      // instead of end-of-day SG, so both sides were eight hours out together.
      { event_id: "e2", contact_id: "c1", round_id: "0526-03", event_type: "attendance", event_date: "2026-05-27T12:00:00Z", lead_round_id: "0526-02", source: "Paid Ads", product: null, amount: null, refund_amount: null },
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
      // 9pm SG on the 19th = 13:00Z. Written as 21:00Z this is 5am on the 20th
      // locally, and the refund row dated "2026-05-19" would no longer find it.
      { event_id: "s1", contact_id: "c1", round_id: "0526-02", event_type: "sale", event_date: "2026-05-19T13:00:00Z", lead_round_id: "0526-02", source: "Paid Ads", product: "preview", amount: "297", refund_amount: "0" },
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
// Re-uploading the same file is normal — people re-drop a file to check they
// committed it. The events dedupe; the parked rows have to as well, or the
// queue doubles and stops meaning "rows waiting".
console.log("\nRe-uploading the same file");
{
  const csv = [
    "Session,Email,Join time",
    "0526-02,known@example.sg,2026-05-19 20:04",
    "0526-02,,2026-05-19 20:06",           // name only — parks
  ].join("\n");

  const tables = () => ({
    rounds: ROUNDS,
    contacts: [{ contact_id: "c1", email: "known@example.sg", phone: null, client_id: "shely" }],
    events: [], ads_performance: [], v_column_map: [],
    unmatched_rows: [] as any[],
  });

  const first = tables();
  const p1 = await planImport(fakeDb(first), { source: "attendance", clientId: "shely", fileName: "a.csv", text: csv });
  eq("first pass parks the nameless row", p1.counts.parked, 1);
  eq("first pass writes the known one", p1.diff.newRows, 1);

  // commit it, then drop the identical file again
  const second = tables();
  second.events = p1.ops.events as any[];
  second.unmatched_rows = p1.ops.unmatched as any[];

  const p2 = await planImport(fakeDb(second), { source: "attendance", clientId: "shely", fileName: "a.csv", text: csv });
  eq("second pass writes nothing", p2.diff.newRows, 0);
  eq("second pass parks NOTHING again", p2.counts.parked, 0);
  eq("the re-seen rows are counted as duplicates", p2.counts.duplicates, 2);

  // a row already dealt with must not come back either
  const resolved = tables();
  resolved.events = p1.ops.events as any[];
  resolved.unmatched_rows = (p1.ops.unmatched as any[]).map((u) => ({ ...u, resolved_at: "2026-05-20T00:00:00Z" }));
  const p3 = await planImport(fakeDb(resolved), { source: "attendance", clientId: "shely", fileName: "a.csv", text: csv });
  ok("a resolved row can be parked again — it left the queue on purpose", p3.counts.parked === 1);
}

// Meta exports an empty report as one row reading "No data available.". It
// parses, it maps, and it produces nothing — so it used to stage a commit
// button for zero rows and then mark the source freshly imported.
console.log("\nA file with nothing usable in it");
{
  const db = fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] });
  const empty = ['"Reporting starts","Amount spent (SGD)"', '"No data available."'].join("\n");

  let refused: ImportError | null = null;
  try {
    await planImport(db, { source: "ads", clientId: "shely", fileName: "ads.csv", text: empty });
  } catch (e) { refused = e as ImportError; }

  ok("an empty Meta export is refused, not staged", refused instanceof ImportError);
  ok("and it says why", Boolean(refused?.message.includes("could be used")));

  // but a file where only SOME rows are unusable still imports the rest
  const partial = [
    "Day,Amount spent (SGD),Ad set name",
    "2026-05-14,412.50,Cold_Broad",
    "not a date,99.00,Cold_Broad",
  ].join("\n");
  const plan = await planImport(db, { source: "ads", clientId: "shely", fileName: "ads.csv", text: partial });
  eq("one good row still lands", plan.diff.newRows, 1);
}

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

// ── Dropping all four files before committing any of them ──────────────────
// The bug this catches is not in the arithmetic — every preview below is
// correct. It is that all three previews are computed against an EMPTY
// database, because a preview reads what has been committed and not what is
// sitting on the next dropzone. Committing in that state attributes every lead
// by date window and parks every attendee and every buyer.
console.log("\nPipeline — import order");
{
  const empty = () => fakeDb({
    rounds: ROUNDS, contacts: [], events: [], ads_performance: [], unmatched_rows: [], v_column_map: [],
  });

  const leads = await planImport(empty(), {
    source: "leads", clientId: "shely", fileName: "2-leads.csv",
    text: "Email,Phone,Created,utm_term\na@x.sg,,2026-05-14,Cold_Broad\nb@x.sg,,2026-05-15,Cold_Broad\n",
  });
  eq("no ads committed: nothing attributes by ad set", leads.attribution.utm, 0);
  eq("no ads committed: everything falls to the date window", leads.attribution.dateWindow, 2);
  ok("no ads committed: leads name the missing file", !!leads.prerequisite?.includes("ads file"));

  const att = await planImport(empty(), {
    source: "attendance", clientId: "shely", fileName: "3-attendance.csv",
    text: "round_id,email,event_date,minutes_watched\n0526-02,a@x.sg,2026-05-19 20:04,74\n",
  });
  eq("no leads committed: every attendee parks", att.counts.parked, 1);
  eq("no leads committed: nothing is written", att.ops.events.length, 0);
  ok("no leads committed: attendance names the missing file", !!att.prerequisite?.includes("leads file"));

  const sale = await planImport(empty(), {
    source: "sales", clientId: "shely", fileName: "4-sales.csv",
    text: "event_date,email,product,amount\n2026-05-20,a@x.sg,preview,297\n",
  });
  eq("no leads committed: every buyer parks", sale.counts.parked, 1);
  ok("no leads committed: sales names the missing file", !!sale.prerequisite?.includes("leads file"));

  // ...and once the file it depends on IS in, the warning goes away rather
  // than nagging forever.
  const withPeople = fakeDb({
    rounds: ROUNDS,
    contacts: [{ contact_id: "c1", email: "a@x.sg", phone: null, client_id: "shely" }],
    events: [{ event_id: "e1", contact_id: "c1", round_id: "0526-02", event_type: "lead",
               event_date: "2026-05-14", lead_round_id: "0526-02", product: null, amount: null,
               refund_amount: null, source: "Paid Ads" }],
    ads_performance: [{ ad_set: "Cold_Broad", round_id: "0526-02", date: "2026-05-14" }],
    unmatched_rows: [], v_column_map: [],
  });
  const ok2 = await planImport(withPeople, {
    source: "attendance", clientId: "shely", fileName: "3-attendance.csv",
    text: "round_id,email,event_date,minutes_watched\n0526-02,a@x.sg,2026-05-19 20:04,74\n",
  });
  eq("in order: the attendee is counted", ok2.ops.events.length, 1);
  ok("in order: no warning", ok2.prerequisite === null);

  const leadsOk = await planImport(withPeople, {
    source: "leads", clientId: "shely", fileName: "2-leads.csv",
    text: "Email,Phone,Created,utm_term\nc@x.sg,,2026-05-14,Cold_Broad\n",
  });
  eq("in order: the lead attributes by ad set", leadsOk.attribution.utm, 1);
  ok("in order: no warning", leadsOk.prerequisite === null);
}

// ── A period-level Meta export dates every row to the window's first day ───
// 1-31 May falls inside no round, so the date rule finds nothing and the whole
// file used to be refused. The campaign name carries the round.
console.log("\nAds — period-level export");
{
  eq("campaign names the round", roundFromCampaign("DF_SG_Preview_Sprint1_0526_02", ROUNDS)?.round_id, "0526-02");
  eq("underscores match hyphens", roundFromCampaign("DF_SG_Preview_Sprint1_0526_03_AI", ROUNDS)?.round_id, "0526-03");
  ok("a campaign naming no round resolves to nothing", roundFromCampaign("New Leads campaign", ROUNDS) === null);
  ok("no campaign, no round", roundFromCampaign(null, ROUNDS) === null);
  // longest id first, so a shorter id can never swallow a longer one
  const both = [...ROUNDS, { round_id: "0526-0", client_id: "shely", start_date: "2026-05-01", end_date: "2026-05-02", session_dates: [] }];
  eq("longest round id wins", roundFromCampaign("camp_0526_02", both)?.round_id, "0526-02");

  const db = fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] });
  const plan = await planImport(db, {
    source: "ads", clientId: "shely", fileName: "ads.csv",
    text: [
      "Reporting starts,Reporting ends,Campaign name,Ad set name,Amount spent (SGD),Impressions,Reach",
      "2026-05-01,2026-05-31,DF_SG_Preview_Sprint1_0526_02,Cold_Broad,259.95,5825,4083",
      "2026-05-01,2026-05-31,DF_SG_Preview_Sprint1_0526_03_AI,Cold_Broad,44.83,1044,969",
    ].join("\n"),
  });
  eq("both rows land", plan.ops.ads.length, 2);
  eq("first row routed by campaign", (plan.ops.ads[0] as any).round_id, "0526-02");
  eq("the _AI campaign routes to the same round", (plan.ops.ads[1] as any).round_id, "0526-03");
  // coverage spans the reporting window, not just its first day
  eq("coverage starts at the window start", plan.coverage.start, "2026-05-01");
  eq("coverage ends at the window end", plan.coverage.end, "2026-05-31");

  // a date that DOES fall in a round still wins — the campaign is the fallback
  const dated = await planImport(fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] }), {
    source: "ads", clientId: "shely", fileName: "ads.csv",
    text: "date,campaign,ad_set,spend\n2026-05-14,DF_SG_Preview_Sprint1_0526_03,Cold_Broad,10",
  });
  eq("a date inside a round beats the campaign name", (dated.ops.ads[0] as any).round_id, "0526-02");
}

// ── a round runs however many classes it runs ───────────────────────────────
console.log("\nRounds — more than one class");
{
  const two = [
    { round_id: "0526-01", client_id: "shely", start_date: "2026-05-04", end_date: "2026-05-08",
      session_dates: ["2026-05-05", "2026-05-07"] },
    ...ROUNDS,
  ];
  eq("an attendance file naming the first class finds the round",
     resolveRoundRef("2026-05-05", two), "0526-01");
  eq("and so does one naming the second",
     resolveRoundRef("2026-05-07", two), "0526-01");
  eq("a date that is nobody's class still finds nothing",
     resolveRoundRef("2026-05-06", two), null);
  eq("a round with no class recorded doesn't throw",
     resolveRoundRef("2026-05-05", [{ round_id: "x", client_id: "shely",
       start_date: "2026-05-01", end_date: "2026-05-02", session_dates: [] }]), null);
  eq("the round id still wins over any date", resolveRoundRef("0526-03", two), "0526-03");
}

// ── channel is recorded, and the assumption is announced ────────────────────
console.log("\nAds — channel");
{
  const base = "date,campaign,ad_set,spend\n2026-05-14,DF_SG_Preview_Sprint1_0526_03,Cold_Broad,10";
  const db = () => fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] });

  const silent = await planImport(db(), { source: "ads", clientId: "shely", fileName: "a.csv", text: base });
  eq("a file with no platform column reads as meta", (silent.ops.ads[0] as any).channel, "meta");
  eq("and says so rather than deciding quietly",
     silent.warnings.some((w) => w.includes("No platform column")), true);

  const named = await planImport(db(), {
    source: "ads", clientId: "shely", fileName: "a.csv",
    text: "date,campaign,ad_set,spend,platform\n2026-05-14,DF_SG_Preview_Sprint1_0526_03,Cold_Broad,10,Google Ads",
  });
  eq("a named platform wins", (named.ops.ads[0] as any).channel, "google");
  eq("and no assumption is announced",
     named.warnings.some((w) => w.includes("No platform column")), false);

  for (const [written, expected] of [["Facebook", "meta"], ["TikTok Ads", "tiktok"], ["Snapchat", "other"]]) {
    const p = await planImport(db(), {
      source: "ads", clientId: "shely", fileName: "a.csv",
      text: `date,campaign,ad_set,spend,channel\n2026-05-14,DF_SG_Preview_Sprint1_0526_03,Cold_Broad,10,${written}`,
    });
    eq(`"${written}" is recorded as ${expected}`, (p.ops.ads[0] as any).channel, expected);
  }

  // 0022 took "channel" off the leads source aliases — it now means the ad
  // platform, and reading it as a lead's source would be a different answer.
  const leads = await planImport(
    fakeDb({ rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [] }),
    { source: "leads", clientId: "shely", fileName: "l.csv",
      text: "email,created,channel\na@b.com,2026-05-14,Meta" },
  );
  eq("a leads column headed 'channel' is not read as the lead's source",
     leads.columnMap.source, undefined);
  eq("and is listed back as unused", leads.unusedColumns.includes("channel"), true);
}

// ── the queue must not double-count a re-import ─────────────────────────────
console.log("\nCommit — re-importing a source retires the batch it replaces");
{
  const SALES = "event_date,email,phone,product,amount\n2026-05-20,,+6591234567,preview,297\n";
  const held = (t: Tables) =>
    (t.unmatched_rows ?? []).filter((r) => !r.resolved_at)
      .reduce((s, r) => s + Number(r.revenue_held ?? 0), 0);
  const waiting = (t: Tables) => (t.unmatched_rows ?? []).filter((r) => !r.resolved_at).length;

  const run = async (t: Tables, batchId: string, text: string) => {
    const db = writableDb(t);
    const plan = await planImport(db, { source: "sales", clientId: "shely", fileName: "s.csv", text });
    (t.import_batches ??= []).push({
      batch_id: batchId, client_id: "shely", source: "sales", status: "staged",
      coverage_start: plan.coverage.start, coverage_end: plan.coverage.end,
    });
    await commitPlan(db, batchId, plan);
    return plan;
  };

  const t: Tables = { rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [], unmatched_rows: [], import_batches: [] };
  await run(t, "b1", SALES);
  eq("first import parks the unmatched buyer", waiting(t), 1);
  eq("and holds their money", held(t), 297);

  await run(t, "b2", SALES);
  eq("re-importing the same file does not park them twice", waiting(t), 1);
  eq("so revenue held stays put instead of doubling", held(t), 297);
  eq("the row moves onto the batch that re-asserted it",
     (t.unmatched_rows ?? []).filter((r) => r.import_batch_id === "b2" && !r.resolved_at).length, 1);

  /**
   * The case that actually bit: the file was EDITED between uploads. A changed
   * column defeats the identical-row guard, so the row parks again under a new
   * id and the old copy stays. Live, that took the queue to 17 rows holding
   * 8,649 against a file describing 9 rows and 4,473.
   */
  const t3: Tables = { rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [], unmatched_rows: [], import_batches: [] };
  await run(t3, "d1", "event_date,email,phone,product,amount,evidence\n2026-05-20,,+6591234567,preview,297,first guess\n");
  await run(t3, "d2", "event_date,email,phone,product,amount,evidence\n2026-05-20,,+6591234567,preview,297,supervisor confirmed\n");
  eq("an edited re-upload does not leave its predecessor behind", waiting(t3), 1);
  eq("and the money is held once, not twice", held(t3), 297);
  eq("the replaced row says why it left",
     (t3.unmatched_rows ?? []).find((r) => r.import_batch_id === "d1")?.resolved_by, "restated");

  // A later period says nothing about an earlier one, so it must not retire it.
  const t2: Tables = { rounds: ROUNDS, contacts: [], events: [], ads_performance: [], v_column_map: [], unmatched_rows: [], import_batches: [] };
  await run(t2, "c1", SALES);
  await run(t2, "c2", "event_date,email,phone,product,amount\n2026-05-27,,+6599999999,preview,297\n");
  eq("a different period leaves the earlier queue alone", waiting(t2), 2);
  eq("and both amounts are still held", held(t2), 594);
}

/**
 * ── CADENCE ────────────────────────────────────────────────────────────────
 * Which of By week and By round is in the sidebar.
 *
 * Tested because the failure is silent in the worst way: no error, no wrong
 * number, just a nav entry that isn't there — which reads as a feature nobody
 * built rather than a bug. The By week tab was already deleted once on the
 * strength of one client's data, so the rule that replaced that decision is
 * worth pinning down.
 */
{
  const workshop = { product_id: "shely-webinar", cadence: "round" as const };
  const evergreen = { product_id: "shely-demo-evergreen", cadence: "week" as const };
  const both = [workshop, evergreen];

  eq("a round product offers By round only",
     cadencesFor([workshop], null).join(","), "round");
  eq("a weekly product offers By week only",
     cadencesFor([evergreen], null).join(","), "week");
  eq("a client selling both, unfiltered, offers both",
     cadencesFor(both, null).join(","), "round,week");
  eq("filtering to the workshop drops the week tab",
     cadencesFor(both, "shely-webinar").join(","), "round");
  eq("filtering to the evergreen product drops the round tab",
     cadencesFor(both, "shely-demo-evergreen").join(","), "week");
  eq("a filter naming a product this client doesn't have falls back to rounds",
     cadencesFor(both, "someone-elses-product").join(","), "round");

  // A database that hasn't run 0026 returns products with no cadence at all.
  // Its sidebar must look exactly as it did, not lose its Overview tabs.
  eq("products with no cadence column still get By round",
     cadencesFor([{ product_id: "shely-webinar" }], null).join(","), "round");
  eq("and a client with no products row at all still gets By round",
     cadencesFor([], null).join(","), "round");

  eq("standing on By round with only weeks lands on By week",
     resolveSpine("round", ["week"]), "week");
  eq("standing on By week with only rounds lands on By round",
     resolveSpine("week", ["round"]), "round");
  eq("both cadences leave By round alone", resolveSpine("round", ["round", "week"]), "round");
  eq("both cadences leave By week alone", resolveSpine("week", ["round", "week"]), "week");
  eq("a tab that is neither is never rewritten", resolveSpine("source", ["week"]), "source");
  eq("including the one it would otherwise collide with", resolveSpine("month", ["week"]), "month");
}

/**
 * ── CHART ──────────────────────────────────────────────────────────────────
 * A chart fails silently by construction: nothing throws when a point is at the
 * wrong height, and a missing round drawn as a zero looks like a measured
 * collapse. These pin the things that would be wrong without being loud.
 */
{
  const cut = (k: string, m: Record<string, unknown>) =>
    ({ cut_key: k, cut_label: k, cut_sub: null, m }) as never;

  eq("an axis top sits above the highest point", niceMax(1294.04), 2000);
  eq("and lands on a round number, not the value", niceMax(41), 50);
  eq("an all-zero series still gets a usable ceiling", niceMax(0), 1);
  eq("so does a series of nothing but blanks", niceMax(-Infinity), 1);

  // Gridline labels have to land ON their lines. A count axis of 0..25 across
  // four gaps put labels at 6.25 and printed them as 6.
  eq("a count ceiling divides evenly by the gridline count", axisMax(21, "i") % (TICKS - 1), 0);
  eq("so every gridline label is a whole person", axisMax(21, "i"), 28);
  eq("21 attendees therefore read 0, 7, 14, 21, 28", ticksFor(axisMax(21, "i")).join(","), "0,7,14,21,28");
  eq("money keeps its round ceiling", axisMax(1294.04, "m"), 2000);
  eq("and there are five gridlines, floor to ceiling", ticksFor(2000).join(","), "0,500,1000,1500,2000");

  eq("a numeric string from PostgREST is a number", num("1294.04"), 1294.04);
  eq("null stays null", num(null), null);
  eq("empty string is absent, not zero", num(""), null);
  eq("and so is a value that isn't a number", num("n/a"), null);

  const rounds = [
    cut("0526-02", { spend: "1294.04", att: 21, cpAtt: "61.62" }),
    cut("0526-03", { spend: "1153.22", att: 19, cpAtt: "60.70" }),
    cut("DEMO-W1", { spend: "500.00", att: null, cpAtt: null }),
  ];

  const eff = chartModel(rounds, "cpAtt");
  eq("spend is always the left line", eff.left.label, "Ads Spent (SGD)");
  eq("and it owns the left axis", eff.left.axis, "left");
  eq("the right line is the objective's efficiency", eff.right.label, "Cost per attendance (SGD)");
  eq("on its own axis", eff.right.axis, "right");
  eq("two scales, not one", eff.left.max === eff.right.max, false);

  const obj = chartModel(rounds, "att");
  eq("picking the amount puts it on the right line", obj.right.label, "Overall Attendance");
  eq("but never the left one", obj.left.label, "Ads Spent (SGD)");

  eq("a blank attendance stays blank rather than becoming 0", obj.right.points[2].value, null);
  eq("but its spend is still plotted", obj.left.points[2].value, 500);
  eq("a series with values is not marked empty", obj.right.empty, false);

  // The one that matters: the line must not run through a round nobody measured.
  eq("the right line stops at the gap instead of crossing it",
     lineRuns(eff.right.points, eff.right.max).length, 1);
  eq("and covers only the rounds that have a number",
     lineRuns(eff.right.points, eff.right.max)[0].length, 2);

  const holed = chartModel(
    [cut("a", { cpAtt: "10" }), cut("b", { cpAtt: null }), cut("c", { cpAtt: "30" })],
    "cpAtt",
  );
  const r2 = lineRuns(holed.right.points, holed.right.max);
  eq("a gap in the middle splits the line into two runs", r2.length, 2);
  eq("left run has one point", r2[0].length, 1);
  eq("right run has one point", r2[1].length, 1);

  eq("a round with nothing on either line is named under the chart",
     chartModel([cut("Q", { spend: null, att: null, cpAtt: null })], "cpAtt").blanks.join(","), "Q");
  eq("a round with any value is not", eff.blanks.length, 0);

  // Geometry: the top of the scale is the top of the plot, the floor is the floor.
  eq("a value at the ceiling reaches the top of the plot", valueY(2000, 2000), floorY() - GEO.plotH);
  eq("half the ceiling is half way up", valueY(1000, 2000), floorY() - GEO.plotH / 2);
  eq("zero sits on the floor", valueY(0, 2000), floorY());
  eq("columns are evenly spaced", Math.round(colX(1, 6) - colX(0, 6)), Math.round(colWidth(6)));

  // Columns divide the target width instead of being a fixed size, so two
  // rounds spread across the pane rather than huddling in its left third.
  eq("two columns split the plot between them", Math.round(colWidth(2)), 620);
  eq("and the chart still fills the target width", chartWidth(2), GEO.targetW);
  eq("enough columns and each one hits the floor width", colWidth(10), GEO.minCol);
  eq("past the floor it stops shrinking and starts scrolling", colWidth(40), GEO.minCol);
  eq("so forty columns are wider than the target", chartWidth(40) > GEO.targetW, true);

  // Ad set names are five times their column wide; SVG does not wrap text.
  eq("a short label is left alone", wrapLabel("0526-02", 20).join("|"), "0526-02");
  eq("a long name breaks at the seam nearest its middle",
     wrapLabel("Cold_ConsultantsServiceProviders", 18).join("|"), "Cold_Consultants|ServiceProviders");
  eq("camelCase counts as a seam",
     wrapLabel("ConsultantsServiceProviders", 16).join("|"), "Consultants|ServiceProviders");
  eq("a name with no seam at all is cut mid-word, not dropped",
     wrapLabel("A".repeat(24), 10).join("|"), "AAAAAAAAAA|AAAAAAAAA…");
  eq("and what it cut is flagged with an ellipsis",
     wrapLabel("A".repeat(24), 10)[1].endsWith("…"), true);
  eq("and never more than two lines", wrapLabel("a_b_c_d_e_f_g_h_i_j_k_l", 6).length, 2);
  eq("more columns means fewer characters each", labelChars(20) < labelChars(4), true);

  eq("ROAS is reachable as its own option",
     chartModel([cut("x", { rev: "5067" })], "roas").right.label, "Overall ROAS");
  eq("and up is better there", chartModel([cut("x", { rev: "5067" })], "roas").vs.betterWhen, "higher");

  /**
   * One control, eight options. It used to be four objectives x two readings,
   * which put the same metric name in both rows at once.
   */
  eq("eight ways to read spend, and no repeats",
     new Set(VS_OPTIONS.map((o) => o.short)).size, 8);
  eq("four are the outcome itself", VS_OPTIONS.filter((o) => o.kind === "amount").length, 4);
  eq("four are its efficiency", VS_OPTIONS.filter((o) => o.kind === "efficiency").length, 4);
  eq("no short label appears in both rows",
     VS_OPTIONS.filter((o) => o.kind === "amount")
       .some((a) => VS_OPTIONS.some((b) => b.kind === "efficiency" && b.short === a.short)), false);
  eq("ROAS sits with the efficiencies but still reads up",
     [vsOption("roas").kind, vsOption("roas").betterWhen].join("/"), "efficiency/higher");
  eq("an unknown vs in the URL falls back rather than throwing", isVs("nonsense"), false);
  eq("and the default is a real option", isVs(DEFAULT_OPTS.vs), true);
}

/**
 * ── THIS ROUND · THE CRO STEPS ─────────────────────────────────────────────
 * This screen makes CLAIMS -- that a metric got worse, that something changed
 * upstream, that an audience is worth cutting. Every one of them is arithmetic
 * that can be wrong quietly, so every one of them is pinned here.
 */
{
  const M = (o: Record<string, unknown>) => o as never;

  // Direction: a cost going up is bad, a rate going up is good, spend is neither.
  eq("a rising cost per lead is worse", compare("cpl", M({ cpl: 12, leads: 100 }), M({ cpl: 10 }), null, null).verdict, "worse");
  eq("a falling cost per lead is better", compare("cpl", M({ cpl: 8, leads: 100 }), M({ cpl: 10 }), null, null).verdict, "better");
  eq("a rising attendance rate is better", compare("attPct", M({ attPct: 30, leads: 100 }), M({ attPct: 20 }), null, null).verdict, "better");
  eq("spend is never judged", compare("spend", M({ spend: 9999 }), M({ spend: 10 }), null, null).verdict, "flat");
  eq("a 1% wobble is not a move", compare("roas", M({ roas: 1.01, prevBuy: 50 }), M({ roas: 1.0 }), null, null).verdict, "flat");

  // Absent must never be compared to anything.
  eq("absent now means no verdict", compare("cpl", M({ cpl: null }), M({ cpl: 10 }), null, null).verdict, "unknown");
  eq("absent before means no verdict", compare("cpl", M({ cpl: 10 }), M({ cpl: null }), null, null).verdict, "unknown");
  eq("and no percentage either", compare("cpl", M({ cpl: 10 }), M({ cpl: null }), null, null).deltaPct, null);
  eq("a move from zero has no percentage", compare("leads", M({ leads: 40 }), M({ leads: 0 }), null, null).deltaPct, null);
  eq("but it is still judged", compare("leads", M({ leads: 40 }), M({ leads: 0 }), null, null).verdict, "better");

  // The promise in the mockup's own footer: never rank on a thin denominator.
  const thinRate = compare("prevPct", M({ prevPct: 10, att: 6 }), M({ prevPct: 20 }), null, null);
  eq("a rate on six attendees is marked thin", thinRate.thin, true);
  eq("and it says what it rests on", thinRate.sample, 6);
  eq("the same rate on forty is not thin",
     compare("prevPct", M({ prevPct: 10, att: 40 }), M({ prevPct: 20 }), null, null).thin, false);
  eq("a count is never thin -- it IS the count",
     compare("leads", M({ leads: 3 }), M({ leads: 9 }), null, null).thin, false);

  // A round with plenty of leads and almost no buyers: the rates resting on
  // leads are actionable, the ones resting on attendance and purchases are not.
  const now = M({ spend: 1000, leads: 100, att: 12, prevBuy: 1, cpl: 20, attPct: 10, prevPct: 5, roas: 0.5 });
  const before = M({ spend: 900, leads: 120, att: 12, prevBuy: 1, cpl: 7.5, attPct: 41, prevPct: 12, roas: 2.0 });
  const moves = movesFor(now, before, null, { cpl: 9 });

  eq("issues are the material, non-thin, worse ones",
     issuesIn(moves).map((m) => m.key).sort().join(","), "attPct,cpl,leads");
  eq("rates resting on 12 attendees and 1 buyer are held back",
     tooThinIn(moves).map((m) => m.key).sort().join(","), "prevPct,roas");
  eq("ROAS on a single sale is never ranked, however far it fell",
     issuesIn(moves).some((m) => m.key === "roas"), false);
  eq("missing a target is reported separately",
     missedTargetIn(moves).map((m) => m.key).join(","), "cpl");
  eq("and only where a target exists", missedTargetIn(movesFor(now, before, null, {})).length, 0);

  // The arrow follows the number; the colour follows whether that is good.
  eq("a cost going up shows an up arrow", moveChip(issuesIn(moves).find((m) => m.key === "cpl")!).text.startsWith("▲"), true);
  eq("and reads bad", moveChip(issuesIn(moves).find((m) => m.key === "cpl")!).tone, "bad");

  // Step 3 -- what changed upstream. Share, not amount: a round that spent twice
  // as much moved every amount and redistributed nothing.
  const A = (name: string, spend: number, leads: number, share: number, round = "R2") =>
    ({ round_id: round, kind: "audience" as const, name, spend, leads, spend_share: share });
  const changes = diffAssets(
    [A("Broad", 400, 20, 40), A("Coaches", 300, 10, 30), A("New_One", 300, 5, 30)],
    [A("Broad", 200, 20, 20, "R1"), A("Coaches", 300, 10, 30, "R1"), A("Gone", 500, 9, 50, "R1")],
  );
  eq("a new audience is flagged", changes.filter((c) => c.change === "added").map((c) => c.name).join(","), "New_One");
  eq("one that stopped running is flagged", changes.filter((c) => c.change === "dropped").map((c) => c.name).join(","), "Gone");
  eq("a 20-point share move is a redistribution",
     changes.filter((c) => c.change === "reweighted").map((c) => c.name).join(","), "Broad");
  eq("and an unchanged share is not mentioned", changes.some((c) => c.name === "Coaches"), false);
  eq("doubling every amount with the same shares changes nothing",
     diffAssets([A("Broad", 800, 20, 50), A("Coaches", 800, 10, 50)],
                [A("Broad", 400, 20, 50, "R1"), A("Coaches", 400, 10, 50, "R1")]).length, 0);

  // Step 7 -- candidates, and the two cases the arithmetic can stand behind.
  const cands = candidatesFrom(
    [A("Dead", 500, 0, 20), A("Pricey", 900, 12, 30), A("Fine", 900, 60, 40), A("Tiny", 12, 0, 10)],
    "0826-01",
  );
  eq("money spent for no leads is a candidate to cut",
     cands.shown.filter((c) => c.kind === "cut").map((c) => c.headline.split(" ")[0]).join(","), "Dead");
  eq("a CPL far off the round's own is a candidate to watch",
     cands.shown.filter((c) => c.kind === "watch").map((c) => c.headline.split(" ")[0]).join(","), "Pricey");
  eq("and a normal one is left alone", cands.shown.some((c) => c.headline.startsWith("Fine")), false);
  eq("no spend at all proposes nothing", candidatesFrom([], "0826-01").shown.length, 0);

  /**
   * The floors. The first real run of this screen proposed a creative at 3.5x
   * the round's CPL on TWO leads -- one more lead would have halved that.
   */
  eq("a CPL multiple on too few leads is not proposed",
     candidatesFrom([A("Noise", 400, 2, 20), A("Fine", 1600, 100, 80)], "R").shown.length, 0);
  eq("the same asset with ten leads is",
     candidatesFrom([A("Noise", 400, 10, 20), A("Fine", 1600, 100, 80)], "R")
       .shown.filter((c) => c.kind === "watch").length, 1);
  eq("and an asset that never spent a lead's worth is not blamed for having none",
     cands.shown.some((c) => c.headline.startsWith("Tiny")), false);

  // A capped list must never read as a complete one.
  const many = Array.from({ length: 9 }, (_, i) => A(`Dead${i}`, 500, 0, 5));
  const capped = candidatesFrom([...many, A("Fine", 4500, 300, 55)], "R");
  eq("the candidate list stops at six", capped.shown.length, 6);
  eq("and says how many it left out", capped.dropped, 3);
  eq("a short list drops nothing", cands.dropped, 0);

  // A move out of zero has no percentage, but it is not "no comparison".
  const outOfZero = compare("midBuy", M({ midBuy: 2 }), M({ midBuy: 0 }), null, null);
  eq("0 to 2 reads as a move, not a blank", moveChip(outOfZero).text, "▲ from 0");
  eq("and it reads as good", moveChip(outOfZero).tone, "good");
  // Into zero is not the same case: it divides by the old figure and has a
  // perfectly good percentage, so it keeps one.
  const intoZero = compare("midBuy", M({ midBuy: 0 }), M({ midBuy: 2 }), null, null);
  eq("2 to 0 keeps its percentage", moveChip(intoZero).text, "▼ 100.0%");
  eq("and it reads as bad", moveChip(intoZero).tone, "bad");
  eq("absent still reads as no comparison",
     moveChip(compare("midBuy", M({ midBuy: null }), M({ midBuy: 2 }), null, null)).tone, "none");

  // How far through the round we are -- the difference between judging a round
  // on day 2 and on day 12.
  eq("mid-round says which day", roundProgress("2026-08-05", "2026-08-18", "2026-08-10"), "day 6 of 14");
  eq("the first day is day 1", roundProgress("2026-08-05", "2026-08-18", "2026-08-05"), "day 1 of 14");
  eq("a finished round says so", roundProgress("2026-08-05", "2026-08-18", "2026-08-20"), "finished · ran 14 days");
  eq("one that hasn't started counts down", roundProgress("2026-08-05", "2026-08-18", "2026-08-01"), "starts in 4 days");
  eq("and no dates means no claim", roundProgress(null, "2026-08-18", "2026-08-10"), null);
}

console.log("\nCLARITY SCROLL");
{
  // A real export, trimmed to five readings. Every quirk that matters is in
  // here: the BOM, the metadata block, the blank lines, the US date order, and
  // page views that disagree with the curve's own base.
  const CLARITY = '﻿' + [
    '"Project name","Shely\'s Landing Page 0526-03"',
    '"Date range","05/25/2026 12:00 AM - 05/27/2026 11:59 PM"',
    "",
    "",
    '"Visited URL matches regex","^https://webinar\\.memiai\\.online/x$"',
    "",
    '"Page views","60"',
    "",
    "",
    '"Metric","Scroll"',
    "",
    '"Scroll depth","No. of visitors","% drop off"',
    '"5","55","5.17"',
    '"10","35","39.66"',
    '"50","28","51.72"',
    '"95","26","55.17"',
    '"100","15","74.14"',
    "",
  ].join("\n");

  const c = parseClarityScroll(CLARITY, "Clarity_Scroll_Mobile_x.csv");

  eq("the project name survives its apostrophe", c.page_label, "Shely's Landing Page 0526-03");
  eq("device comes off the file name", c.device, "mobile");
  eq("a file that names no device says so", deviceFromName("Clarity_Scroll_x.csv"), "all");

  // Clarity is a Microsoft product and writes MM/DD/YYYY. toDate() resolves an
  // ambiguous slash date DAY-first, which is right for the SG exports it was
  // written for and would put this export a month out.
  eq("US date order, not the shared day-first rule", c.captured_from, "2026-05-25");
  eq("and the far end too", c.captured_to, "2026-05-27");
  eq("the shared reader would have disagreed", toDate("05/06/2026"), "2026-06-05");

  // THE DENOMINATOR. Page views is 60 and the curve is built on 58: a view that
  // never fired a scroll event is a view and is not on the curve. Reading the
  // 60 would understate every band by 3.3% and nothing would show it.
  eq("sessions come from the curve, not from page views", c.sessions, 58);
  eq("page views are kept anyway", c.page_views, 60);
  eq("every row agrees on the base", sessionsFrom(c.points).spread, 0);
  eq("all five readings survive", c.points.length, 5);
  eq("and they are in depth order", c.points.map((p) => p.depth), [5, 10, 50, 95, 100]);

  // Wrong file, refused by name rather than half-read.
  ok("a clicks export is refused", (() => {
    try { parseClarityScroll(CLARITY.replace('"Scroll"', '"Clicks"'), "x.csv"); return false; }
    catch (e) { return e instanceof ClarityError && /not Scroll/.test(e.message); }
  })());
  ok("a file with no curve in it is refused", (() => {
    try { parseClarityScroll('"Project name","x"\n"Metric","Scroll"\n', "x.csv"); return false; }
    catch (e) { return e instanceof ClarityError; }
  })());

  // ── the curve, as shares ────────────────────────────────────────────────
  const curve = curveOf(c.points, c.sessions);
  eq("the first band's loss is the bounce", curve[0].lost, 3);
  eq("stated as a share", Number(curve[0].lostPts.toFixed(2)), 5.17);
  eq("retention at the bottom", Number(curve[4].pct.toFixed(2)), 25.86);

  // The worst step is the SECOND reading here, and the loop has to start from
  // sessions rather than from the first reading or it could never say so.
  const worst = biggestDrop(curve)!;
  eq("the biggest fall is found", worst.depth, 10);
  eq("and it is 20 sessions", worst.lost, 20);

  // ── the constraint ──────────────────────────────────────────────────────
  // 0526-03: 141 leads on 377 clicks = 37.40%. At 95% depth 44.83% are still
  // reading; at 100% only 25.86% are. So the form is at or above 95%.
  const leadGen = (141 / 377) * 100;
  const bounded = ceilingOf(curve, leadGen);
  eq("the form is bounded above the last band", bounded.kind, "bounded");
  eq("at the deepest band that clears lead gen", (bounded as { depth: number }).depth, 95);

  // If everyone who converted was still present at the bottom, scroll is not
  // the constraint — and saying "the form is above 100%" would be nonsense.
  eq("a curve that clears it everywhere is unbounded",
     ceilingOf(curve, 10).kind, "unbounded");

  // More conversions than scrollers is not a finding, it is a contradiction.
  eq("and one that clears it nowhere is impossible",
     ceilingOf(curve, 99).kind, "impossible");
  eq("no lead gen means no claim", ceilingOf(curve, null).kind, "unknown");

  // ── coverage ────────────────────────────────────────────────────────────
  const thin = coverageOf(58, 377);
  eq("58 sessions against 377 clicks is a sample", thin.thin, true);
  eq("and the share is stated", Number(thin.pct!.toFixed(1)), 15.4);
  eq("full coverage is not thin", coverageOf(340, 377).thin, false);
  eq("but a small sample is, however complete", coverageOf(12, 12).thin, true);
  // Clarity seeing more than the ads bought is organic traffic, not an error.
  const over = coverageOf(500, 377);
  eq("more sessions than clicks is its own case", over.over, true);
  eq("and it is not called thin", over.thin, false);

  // ── which round a window describes ──────────────────────────────────────
  const R = (id: string, s: string, e: string) =>
    ({ round_id: id, client_id: "shely", start_date: s, end_date: e, session_dates: [] });
  const rs = [R("0526-02", "2026-05-13", "2026-05-19"), R("0526-03", "2026-05-23", "2026-05-27")];
  eq("a window inside a round picks it",
     roundForWindow("2026-05-25", "2026-05-27", rs)?.round.round_id, "0526-03");
  // Overlap, not containment: "last 7 days" over a 5-day round is the ordinary
  // case and refusing it would refuse most real exports.
  const wide = roundForWindow("2026-05-21", "2026-05-27", rs)!;
  eq("a wider window still picks the round it covers", wide.round.round_id, "0526-03");
  eq("and reports how much of it actually overlapped", [wide.days, wide.span], [5, 7]);
  eq("most overlap wins when two rounds are in range",
     roundForWindow("2026-05-18", "2026-05-24", rs)?.round.round_id, "0526-02");
  eq("a window touching no round picks none",
     roundForWindow("2026-05-20", "2026-05-22", rs), null);
  eq("and no dates at all picks none", roundForWindow(null, null, rs), null);

  // Two device exports of one round are shown separately, largest first — they
  // are not summable, so this only decides reading order.
  const run = (id: string, dev: string, n: number): ScrollRun => ({
    run_id: id, round_id: "0526-03", page_label: null, device: dev, sessions: n,
    page_views: null, captured_from: null, captured_to: null, points: [],
  });
  eq("the biggest sample is read first",
     runsFor([run("a", "desktop", 20), run("b", "mobile", 58)], "0526-03").map((r) => r.run_id),
     ["b", "a"]);
  eq("another round's curve is not shown", runsFor([run("a", "mobile", 58)], "DEMO-W1").length, 0);

  // ── the whole way through the importer ──────────────────────────────────
  const tables: any = { rounds: ROUNDS, round_sessions: [], scroll_runs: [], scroll_depths: [], import_batches: [] };
  const wdb = writableDb(tables);
  const plan = await planImport(wdb, {
    source: "scroll", clientId: "shely", fileName: "Clarity_Scroll_Mobile.csv", text: CLARITY,
  });

  eq("the round comes off the date range", plan.ops.scroll!.run.round_id, "0526-03");
  eq("a scroll import writes no events", plan.ops.events.length, 0);
  eq("and parks nobody", plan.ops.unmatched.length, 0);
  eq("the curve is what it writes", plan.diff.newRows, 5);
  eq("coverage is the export's own window", [plan.coverage.start, plan.coverage.end],
     ["2026-05-25", "2026-05-27"]);
  ok("page views disagreeing with the base is said out loud",
     plan.warnings.some((w) => /60 page views/.test(w) && /58 sessions/.test(w)),
     `\n       ${plan.warnings.join("\n       ")}`);

  await commitPlan(wdb, "batch-1", plan);
  eq("one run is stored", tables.scroll_runs.length, 1);
  eq("with all five readings", tables.scroll_depths.length, 5);

  // Re-exporting the same days is how late data arrives. It must REPLACE:
  // two copies of one measurement would read as twice the traffic.
  const again = await planImport(wdb, {
    source: "scroll", clientId: "shely", fileName: "Clarity_Scroll_Mobile.csv", text: CLARITY,
  });
  eq("a re-export is a change, not an insert", [again.diff.newRows, again.diff.changedRows], [0, 5]);
  ok("and it says it would restate what is stored", again.diff.restatements.length === 1);

  await commitPlan(wdb, "batch-2", again);
  eq("there is still only one run", tables.scroll_runs.length, 1);
  eq("and still only five readings", tables.scroll_depths.length, 5);

  // A window no round covers is refused with the rounds named, not filed
  // against whichever round happens to be nearest.
  ok("a window outside every round is refused", await (async () => {
    try {
      await planImport(writableDb({ rounds: ROUNDS, round_sessions: [] }), {
        source: "scroll", clientId: "shely", fileName: "x.csv",
        text: CLARITY.replace("05/25/2026", "09/25/2026").replace("05/27/2026", "09/27/2026"),
      });
      return false;
    } catch (e) {
      return e instanceof ImportError && /No round overlaps/.test(e.message)
          && (e.detail ?? []).some((d) => /0526-03/.test(d));
    }
  })());
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
