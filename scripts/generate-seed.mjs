/**
 * Generates supabase/migrations/0002_seed.sql from the ratified mockup numbers.
 *
 * Every figure below is lifted from the Funnel OS mockup artifact. The script's
 * job is to turn *displayed aggregates* back into *rows*, so the 29-metric views
 * recompute them from real data rather than us hardcoding them.
 *
 * Two margins have to hold simultaneously:
 *   - By Round      — each round's spend/reach/impressions/clicks/leads/attendance/sales
 *   - Targeted Views — each audience's same figures, summed across rounds
 * That's a transportation problem (fixed row totals + fixed column totals), solved
 * exactly with integer allocation in `fit()` below.
 *
 * Run: node scripts/generate-seed.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE MOCKUP'S NUMBERS
// ═══════════════════════════════════════════════════════════════════════════

// By Round tab — every column, exactly as displayed.
// 0426-01 is the April backfill: the mockup's month view is labelled "Apr–Aug"
// and its Targeted Views totals (12,897.14 spend / 248,692 impressions) exceed
// the six displayed rounds. That residual is April's, and it's ads-only —
// leads/attendance/sales for it were never imported.
const ROUNDS = [
  {
    id: "0426-01", start: "2026-04-07", end: "2026-04-20", session: "2026-04-20",
    label: "Apr backfill — ads only", adsOnly: true,
    spend: 2823.09, reach: 44714, impr: 52762, clicks: 727,
  },
  {
    id: "0526-02", start: "2026-05-13", end: "2026-05-19", session: "2026-05-19",
    label: "Class A — Wed 8pm",
    spend: 1378.24, reach: 12672, impr: 30257, clicks: 479,
    leads: 207, att: 50, prevBuy: 11, midBuy: 4, midRev: 4991,
  },
  {
    id: "0526-03", start: "2026-05-23", end: "2026-05-27", session: "2026-05-27",
    label: "Class A — Wed 8pm",
    spend: 1153.22, reach: 10131, impr: 22669, clicks: 377,
    leads: 208, att: 80, prevBuy: 10, midBuy: 5, midRev: 8200,
  },
  {
    id: "0626-01", start: "2026-06-05", end: "2026-06-08", session: "2026-06-08",
    label: "Class A — Wed 8pm",
    spend: 1043.77, reach: 10180, impr: 17654, clicks: 246,
    leads: 130, att: 40, prevBuy: 1, midBuy: 0, midRev: 0,
  },
  {
    id: "0726-01", start: "2026-07-03", end: "2026-07-07", session: "2026-07-07",
    label: "Class A — Wed 8pm",
    spend: 2365.73, reach: 38009, impr: 45425, clicks: 733,
    leads: 144, att: 33, prevBuy: 8, midBuy: 2, midRev: 9000,
  },
  {
    id: "0726-03", start: "2026-07-24", end: "2026-07-28", session: "2026-07-28",
    label: "Class B — Sat 10am",
    spend: 1753.09, reach: 28558, impr: 33308, clicks: 537,
    leads: 112, att: 16, prevBuy: 1, midBuy: 1, midRev: 9000,
  },
  {
    id: "0826-01", start: "2026-08-05", end: "2026-08-18", session: "2026-08-12",
    label: "Class A — Wed 8pm",
    spend: 2380.00, reach: 39076, impr: 46617, clicks: 691,
    leads: 304, att: 81, prevBuy: 14, midBuy: 1, midRev: 3000,
  },
];

// Targeted Views tab — the six audiences (ads_performance.ad_set), summed across rounds.
const AUDIENCES = [
  { name: "Cold_CourseCreators",      spend: 1753.09, reach: 28558, impr: 33308, clicks: 537, leads: 112, att: 16, prevBuy: 1, midBuy: 1, midRev: 9000 },
  { name: "Cold_CoachesLifeCoaches",  spend: 2365.73, reach: 38009, impr: 45425, clicks: 733, leads: 144, att: 33, prevBuy: 8, midBuy: 2, midRev: 9000 },
  { name: "Cold_Consultants",         spend: 2204.47, reach: 35719, impr: 42195, clicks: 594, leads: 123, att: 29, prevBuy: 6, midBuy: 1, midRev: 3197 },
  { name: "Cold_BusinessOwners",      spend: 2217.37, reach: 36072, impr: 42826, clicks: 652, leads: 153, att: 32, prevBuy: 7, midBuy: 1, midRev: 1400 },
  { name: "Cold_Broad",               spend: 2380.00, reach: 39076, impr: 46617, clicks: 691, leads: 160, att: 35, prevBuy: 5, midBuy: 0, midRev: 0 },
  { name: "Cold_CorporateTrainers",   spend: 1976.48, reach: 32676, impr: 38321, clicks: 583, leads: 136, att: 20, prevBuy: 3, midBuy: 0, midRev: 0 },
];

// Creatives (Ads tab — not wired today, but ads_performance.ad must not be null).
const CREATIVES = [
  "ContentAtScale_Structured", "LetAISellYourProducts", "ContentAtScale_V2",
  "GoViralWithoutShowingFace", "ContentAtScale_Text", "MoreSales_Text",
];

const PREVIEW_PRICE = 297;

// How much of each round is Paid Ads (i.e. bridges to an audience column).
// 0526-03 and 0626-01 are pinned by the mockup's Round × Source tab; the rest are
// chosen so the column totals above are hit exactly.
const PAID = {
  "0526-02": { leads: 150, att: 44, prevBuy: 9 },
  "0526-03": { leads: 135, att: 12, prevBuy: 1 },   // Round × source: 135 / 12 / 1
  "0626-01": { leads:  92, att:  2, prevBuy: 0 },   // Round × source: 92 / 2 / 0 — the 2.17% cell
  "0726-01": { leads: 120, att: 28, prevBuy: 8 },
  "0726-03": { leads:  95, att: 14, prevBuy: 1 },
  "0826-01": { leads: 236, att: 65, prevBuy: 11 },
};

// Middle-offer sales are individually enumerated: the mockup's per-round middle
// revenue (e.g. 4 sales worth 4,991) doesn't divide evenly by the 3,000 list
// price, so amounts are explicit. `aud` = which audience column the sale lands in
// (null = not Paid Ads).
const MIDDLE_SALES = [
  // round      amount  audience                     source
  ["0526-02",   3197,  "Cold_Consultants",           "Paid Ads"],
  ["0526-02",   1400,  "Cold_BusinessOwners",        "Paid Ads"],
  ["0526-02",    197,  null,                         "Organic"],
  ["0526-02",    197,  null,                         "AOAI"],
  // 0526-03 totals 8,200 over 5 sales, split exactly as the Round × source tab has it:
  // Paid Ads 2,000 (1) · Organic 2,800 (2) · AOAI 3,400 (2)
  ["0526-03",   2000,  "Cold_CoachesLifeCoaches",    "Paid Ads"],
  ["0526-03",   1400,  null,                         "Organic"],
  ["0526-03",   1400,  null,                         "Organic"],
  ["0526-03",   1700,  null,                         "AOAI"],
  ["0526-03",   1700,  null,                         "AOAI"],
  ["0726-01",   7000,  "Cold_CoachesLifeCoaches",    "Paid Ads"],
  ["0726-01",   2000,  null,                         "Organic"],
  ["0726-03",   9000,  "Cold_CourseCreators",        "Paid Ads"],
  ["0826-01",   3000,  null,                         "Organic"],
];

// Non-paid breakdown per round: [source, leads, att, prevBuy].
// 0526-03 and 0626-01 are pinned by the Round × source tab.
const UNPAID = {
  // 0526-02 sends 2 preview sales forward: those leads skipped their own class,
  // attended 0526-03 and bought there. Revenue credits back to 0526-02 via
  // lead_round_id, so 0526-02's own-round buyers are 9 and its By Round figure is 11.
  // That is the mockup's "0526-02 gets its revenue back" notice, working.
  "0526-02": [["Organic", 35, 4, 0], ["AOAI", 12, 1, 0], ["Previous Paid Ads", 10, 1, 0]],
  "0526-03": [["Organic", 44, 43, 5], ["AOAI", 16, 12, 4], ["Previous Paid Ads", 13, 13, 2]],
  "0626-01": [["Organic", 26, 26, 1], ["AOAI",  8,  8, 0], ["Previous Paid Ads",  4,  4, 0]],
  "0726-01": [["Organic", 14,  3, 0], ["AOAI",  4,  1, 0], ["Previous Paid Ads",  6,  1, 0]],
  "0726-03": [["Organic",  9,  1, 0], ["AOAI",  4,  1, 0], ["Previous Paid Ads",  4,  0, 0]],
  "0826-01": [["Organic", 40, 10, 2], ["AOAI", 15,  4, 1], ["Previous Paid Ads", 13,  2, 0]],
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. INTEGER TRANSPORTATION FIT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Allocate a non-negative integer matrix with exactly the given row and column
 * totals, as close to proportional (rowᵢ × colⱼ / grand) as integers allow.
 * Greedy proportional fill with remainder repair.
 */
function fit(rowTotals, colTotals, label) {
  const R = rowTotals.length, C = colTotals.length;
  const grand = rowTotals.reduce((a, b) => a + b, 0);
  const colSum = colTotals.reduce((a, b) => a + b, 0);
  if (grand !== colSum) {
    throw new Error(`${label}: row total ${grand} != column total ${colSum}`);
  }
  const m = Array.from({ length: R }, () => new Array(C).fill(0));
  if (grand === 0) return m;

  const remRow = [...rowTotals], remCol = [...colTotals];
  // Fill proportionally, largest-remainder within each row, clamped by column capacity.
  for (let r = 0; r < R; r++) {
    if (remRow[r] === 0) continue;
    const remGrand = remCol.reduce((a, b) => a + b, 0);
    const want = remCol.map((c) => (remGrand ? (remRow[r] * c) / remGrand : 0));
    const base = want.map((w, j) => Math.min(Math.floor(w), remCol[j]));
    let left = remRow[r] - base.reduce((a, b) => a + b, 0);
    const order = want
      .map((w, j) => ({ j, frac: w - Math.floor(w) }))
      .sort((a, b) => b.frac - a.frac);
    // hand out the remainder, then any shortfall from clamping, by capacity
    for (let pass = 0; left > 0 && pass < 3; pass++) {
      for (const { j } of order) {
        if (left === 0) break;
        const room = remCol[j] - base[j];
        if (room <= 0) continue;
        const give = pass === 0 ? Math.min(1, room, left) : Math.min(room, left);
        base[j] += give;
        left -= give;
      }
    }
    if (left !== 0) throw new Error(`${label}: row ${r} could not be allocated (${left} left)`);
    for (let j = 0; j < C; j++) { m[r][j] = base[j]; remCol[j] -= base[j]; }
    remRow[r] = 0;
  }
  if (remCol.some((c) => c !== 0)) {
    throw new Error(`${label}: columns left over ${JSON.stringify(remCol)}`);
  }
  // Verify
  for (let r = 0; r < R; r++) {
    const s = m[r].reduce((a, b) => a + b, 0);
    if (s !== rowTotals[r]) throw new Error(`${label}: row ${r} sums ${s} != ${rowTotals[r]}`);
  }
  for (let j = 0; j < C; j++) {
    const s = m.reduce((a, row) => a + row[j], 0);
    if (s !== colTotals[j]) throw new Error(`${label}: col ${j} sums ${s} != ${colTotals[j]}`);
  }
  return m;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. DETERMINISTIC IDS
// ═══════════════════════════════════════════════════════════════════════════

let uuidCounter = 0;
const uuid = (prefix) => {
  const n = (++uuidCounter).toString(16).padStart(12, "0");
  const p = prefix.toString(16).padStart(4, "0").slice(-4);
  return `f0000000-0000-4000-8${p.slice(0, 3)}-${n}`;
};

const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const n = (v) => (v === null || v === undefined ? "NULL" : String(v));

// Spread a round's rows over its date window.
function datesIn(round, count) {
  const start = new Date(round.start + "T00:00:00Z");
  const end = new Date(round.end + "T00:00:00Z");
  const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime() + (i % days) * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. ADS — round × audience
// ═══════════════════════════════════════════════════════════════════════════

const audNames = AUDIENCES.map((a) => a.name);

// Reach is the one metric that cannot hold on both margins: the six rounds carry
// 138,626 and the six audiences 210,110, so the April residual would need 71,484
// reach against 52,762 impressions — impossible (reach <= impressions always).
// We keep April physically sane and scale the audience reach column instead.
const roundReachTotal = ROUNDS.reduce((s, r) => s + r.reach, 0);
const audReachRaw = AUDIENCES.map((a) => a.reach);
const audReachSum = audReachRaw.reduce((a, b) => a + b, 0);
const audReach = (() => {
  const scaled = audReachRaw.map((v) => Math.round((v * roundReachTotal) / audReachSum));
  const diff = roundReachTotal - scaled.reduce((a, b) => a + b, 0);
  scaled[0] += diff;
  return scaled;
})();

const adsMatrix = {
  spend:  fit(ROUNDS.map((r) => Math.round(r.spend * 100)), AUDIENCES.map((a) => Math.round(a.spend * 100)), "ads.spend"),
  impr:   fit(ROUNDS.map((r) => r.impr),   AUDIENCES.map((a) => a.impr),   "ads.impr"),
  clicks: fit(ROUNDS.map((r) => r.clicks), AUDIENCES.map((a) => a.clicks), "ads.clicks"),
  reach:  fit(ROUNDS.map((r) => r.reach),  audReach,                        "ads.reach"),
};

// ═══════════════════════════════════════════════════════════════════════════
// 5. EVENTS — round × audience (Paid Ads only), plus unpaid rows
// ═══════════════════════════════════════════════════════════════════════════

const eventRounds = ROUNDS.filter((r) => !r.adsOnly);

const paidLeadM = fit(eventRounds.map((r) => PAID[r.id].leads),   AUDIENCES.map((a) => a.leads),   "events.leads");
const paidAttM  = fit(eventRounds.map((r) => PAID[r.id].att),     AUDIENCES.map((a) => a.att),     "events.att");
const paidPrevM = fit(eventRounds.map((r) => PAID[r.id].prevBuy), AUDIENCES.map((a) => a.prevBuy), "events.prevBuy");

// ═══════════════════════════════════════════════════════════════════════════
// 6. BUILD ROWS
// ═══════════════════════════════════════════════════════════════════════════

const contacts = [];
const events = [];
const ads = [];

const CLIENT = "shely";
const batchAds = uuid(1), batchLeads = uuid(1), batchAtt = uuid(1), batchSales = uuid(1);

// ── ads_performance ────────────────────────────────────────────────────────
ROUNDS.forEach((round, ri) => {
  const dates = datesIn(round, audNames.length);
  audNames.forEach((adSet, ai) => {
    const spendCents = adsMatrix.spend[ri][ai];
    const impr = adsMatrix.impr[ri][ai];
    if (spendCents === 0 && impr === 0) return;
    ads.push({
      id: uuid(2),
      round_id: round.id,
      date: dates[ai],
      campaign: "Shely — Webinar Leads",
      ad_set: adSet,
      ad: CREATIVES[(ri + ai) % CREATIVES.length],
      spend: (spendCents / 100).toFixed(2),
      impressions: impr,
      reach: adsMatrix.reach[ri][ai],
      clicks: adsMatrix.clicks[ri][ai],
      batch: batchAds,
    });
  });
});

// ── contacts + events ──────────────────────────────────────────────────────
let personSeq = 0;
const newContact = () => {
  const id = uuid(3);
  personSeq += 1;
  contacts.push({
    id,
    email: `lead${String(personSeq).padStart(4, "0")}@example.sg`,
    phone: `+6590${String(100000 + personSeq).slice(-6)}`,
    client_id: CLIENT,
  });
  return id;
};

// Pools of contacts per round who attended, so sales attach to real attendees.
const attendeesByRound = {};
// Paid contacts by earlier round, for the "Previous Paid Ads" derivation.
const paidLeadsByRound = {};

const ts = (date, h = 10, m = 0) => `${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`;

eventRounds.forEach((round, ri) => {
  const leadDates = datesIn(round, Math.max(round.leads, 1));
  attendeesByRound[round.id] = { paid: [], unpaid: {} };
  paidLeadsByRound[round.id] = [];
  let leadIdx = 0;

  // ── Paid Ads leads, split across audiences (utm_campaign = ad set) ────────
  audNames.forEach((adSet, ai) => {
    const count = paidLeadM[ri][ai];
    const attCount = paidAttM[ri][ai];
    const madeIt = [];
    for (let k = 0; k < count; k++) {
      const cid = newContact();
      const d = leadDates[leadIdx++ % leadDates.length];
      events.push({
        id: uuid(4), contact_id: cid, round_id: round.id, event_type: "lead",
        event_date: ts(d, 9, k % 60),
        lead_round_id: round.id, close_round_id: null,
        attribution_method: "utm", utm_campaign: adSet, source: "Paid Ads",
        match_status: "matched", product: null, minutes_watched: null,
        amount: null, refund_amount: 0, refund_date: null, is_lead: null,
        batch: batchLeads,
      });
      paidLeadsByRound[round.id].push({ cid, adSet });
      if (k < attCount) madeIt.push({ cid, adSet });
    }
    // attendance for the ones who showed
    madeIt.forEach(({ cid }, k) => {
      events.push({
        id: uuid(5), contact_id: cid, round_id: round.id, event_type: "attendance",
        event_date: ts(round.session, 20, k % 60),
        lead_round_id: round.id, close_round_id: null,
        attribution_method: null, utm_campaign: adSet, source: "Paid Ads",
        match_status: "matched", product: null, minutes_watched: 45 + (k % 70),
        amount: null, refund_amount: 0, refund_date: null, is_lead: null,
        batch: batchAtt,
      });
    });
    attendeesByRound[round.id].paid.push(...madeIt);
  });

  // ── Unpaid leads + attendance ────────────────────────────────────────────
  UNPAID[round.id].forEach(([source, leads, att]) => {
    const pool = [];
    for (let k = 0; k < leads; k++) {
      // "Previous Paid Ads" people already exist — they were a Paid Ads lead in an
      // earlier round. Their lead_round_id stays on that earlier round, and they
      // carry no utm_campaign here so Targeted Views doesn't count them twice.
      const isPrevious = source === "Previous Paid Ads";
      let cid, originRound = round.id;
      if (isPrevious) {
        const earlier = eventRounds
          .slice(0, ri)
          .flatMap((r) => paidLeadsByRound[r.id].map((p) => ({ ...p, round: r.id })));
        if (earlier.length) {
          const pick = earlier[(k * 7 + ri * 13) % earlier.length];
          cid = pick.cid;
          originRound = pick.round;
        } else {
          cid = newContact();
        }
      } else {
        cid = newContact();
      }
      const d = leadDates[leadIdx++ % leadDates.length];
      events.push({
        id: uuid(6), contact_id: cid, round_id: round.id, event_type: "lead",
        event_date: ts(d, 11, k % 60),
        lead_round_id: originRound, close_round_id: null,
        attribution_method: isPrevious ? "utm" : "date_window",
        utm_campaign: null,
        source: isPrevious ? "Paid Ads" : source,
        match_status: "matched", product: null, minutes_watched: null,
        amount: null, refund_amount: 0, refund_date: null, is_lead: null,
        batch: batchLeads,
      });
      pool.push({ cid, source, originRound, isPrevious });
    }
    const showed = pool.slice(0, att);
    showed.forEach(({ cid, originRound, isPrevious }, k) => {
      events.push({
        id: uuid(7), contact_id: cid, round_id: round.id, event_type: "attendance",
        event_date: ts(round.session, 20, 30 + (k % 30)),
        lead_round_id: originRound, close_round_id: null,
        attribution_method: null, utm_campaign: null,
        source: isPrevious ? "Paid Ads" : source,
        match_status: "matched", product: null, minutes_watched: 50 + (k % 65),
        amount: null, refund_amount: 0, refund_date: null, is_lead: null,
        batch: batchAtt,
      });
    });
    attendeesByRound[round.id].unpaid[source] = showed;
  });
});

// ── Preview sales ──────────────────────────────────────────────────────────
// Revenue is credited by lead_round_id, so a preview sale sits on the round that
// produced the lead. close_round_id = the class they actually attended.
eventRounds.forEach((round, ri) => {
  const pool = attendeesByRound[round.id];

  // Paid Ads preview buyers, per audience column
  audNames.forEach((adSet, ai) => {
    const count = paidPrevM[ri][ai];
    const buyers = pool.paid.filter((p) => p.adSet === adSet).slice(0, count);
    buyers.forEach(({ cid }, k) => {
      events.push({
        id: uuid(8), contact_id: cid, round_id: round.id, event_type: "sale",
        event_date: ts(round.session, 21, k % 50),
        lead_round_id: round.id, close_round_id: round.id,
        attribution_method: null, utm_campaign: adSet, source: "Paid Ads",
        match_status: "matched", product: "preview", minutes_watched: null,
        amount: PREVIEW_PRICE, refund_amount: 0, refund_date: null, is_lead: true,
        batch: batchSales,
      });
    });
  });

  // Unpaid preview buyers
  UNPAID[round.id].forEach(([source, , , prevBuy]) => {
    const showed = pool.unpaid[source] ?? [];
    showed.slice(0, prevBuy).forEach(({ cid, originRound, isPrevious }, k) => {
      events.push({
        id: uuid(9), contact_id: cid, round_id: round.id, event_type: "sale",
        event_date: ts(round.session, 21, 30 + (k % 25)),
        // Previous-round leads: revenue goes back to the round that paid for them,
        // closing credit stays with the class they attended. Both true at once.
        lead_round_id: originRound, close_round_id: round.id,
        attribution_method: null, utm_campaign: null,
        source: isPrevious ? "Paid Ads" : source,
        match_status: "matched", product: "preview", minutes_watched: null,
        amount: PREVIEW_PRICE, refund_amount: 0, refund_date: null, is_lead: true,
        batch: batchSales,
      });
    });
  });
});

// ── Middle sales ───────────────────────────────────────────────────────────
MIDDLE_SALES.forEach(([roundId, amount, adSet, source], i) => {
  const round = eventRounds.find((r) => r.id === roundId);
  const pool = attendeesByRound[roundId];
  const candidate =
    (adSet ? pool.paid.find((p) => p.adSet === adSet) : null) ??
    pool.unpaid[source]?.[0] ??
    pool.paid[0];
  const cid = candidate ? candidate.cid : newContact();
  events.push({
    id: uuid(10), contact_id: cid, round_id: roundId, event_type: "sale",
    event_date: ts(round.session, 22, i % 55),
    lead_round_id: roundId, close_round_id: roundId,
    attribution_method: null, utm_campaign: adSet, source,
    match_status: "matched", product: "middle", minutes_watched: null,
    amount, refund_amount: 0, refund_date: null, is_lead: true,
    batch: batchSales,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. NORTHSEA SUPPLY — second client, so the switcher is real
// The mockup's Northsea figures are illustrative (its own footer says so), and
// 29,665 lead events is not a seed. Scaled down 100×, same journey shape.
// ═══════════════════════════════════════════════════════════════════════════

const NS_ROUNDS = [
  { id: "NS-0726-01", start: "2026-07-01", end: "2026-07-31", session: "2026-07-31", label: "July always-on" },
  { id: "NS-0826-01", start: "2026-08-01", end: "2026-08-18", session: "2026-08-18", label: "August always-on" },
];
const NS_PAGES = [
  { name: "PDP — Deck Jacket",     spend: 11132, impr: 198400, clicks: 3946, leads: 142, buys: 99, rev: 42310 },
  { name: "PDP — Fisherman Knit",  spend:  9117, impr: 151300, clicks: 2932, leads:  94, buys: 51, rev: 21880 },
  { name: "PDP — Oilskin Tote",    spend:  3931, impr:  63200, clicks: 1326, leads:  60, buys: 20, rev:  5940 },
];
const nsBatchAds = uuid(11), nsBatchLeads = uuid(11), nsBatchSales = uuid(11);

NS_PAGES.forEach((page, pi) => {
  NS_ROUNDS.forEach((round, ri) => {
    const half = ri === 0 ? 0.6 : 0.4;
    ads.push({
      id: uuid(12), round_id: round.id, date: round.start,
      campaign: "Northsea — Prospecting", ad_set: page.name, ad: `${page.name} — carousel`,
      spend: (page.spend * half).toFixed(2),
      impressions: Math.round(page.impr * half),
      reach: Math.round(page.impr * half * 0.82),
      clicks: Math.round(page.clicks * half),
      batch: nsBatchAds,
    });
  });
  // leads + sales on the first round, enough to make the journey strip real
  const round = NS_ROUNDS[0];
  for (let k = 0; k < page.leads; k++) {
    const id = uuid(13);
    contacts.push({ id, email: `ns${pi}-${k}@example.sg`, phone: null, client_id: "northsea_supply" });
    events.push({
      id: uuid(14), contact_id: id, round_id: round.id, event_type: "lead",
      event_date: ts(round.start, 12, k % 60),
      lead_round_id: round.id, close_round_id: null,
      attribution_method: "utm", utm_campaign: page.name, source: "Paid Ads",
      match_status: "matched", product: null, minutes_watched: null,
      amount: null, refund_amount: 0, refund_date: null, is_lead: null, batch: nsBatchLeads,
    });
    if (k < page.buys) {
      events.push({
        id: uuid(15), contact_id: id, round_id: round.id, event_type: "sale",
        event_date: ts(round.start, 13, k % 60),
        lead_round_id: round.id, close_round_id: round.id,
        attribution_method: null, utm_campaign: page.name, source: "Paid Ads",
        match_status: "matched", product: "preview", minutes_watched: null,
        amount: (page.rev / page.buys).toFixed(2), refund_amount: 0, refund_date: null,
        is_lead: true, batch: nsBatchSales,
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. EMIT SQL
// ═══════════════════════════════════════════════════════════════════════════

const chunks = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const L = [];
L.push(`-- ═══════════════════════════════════════════════════════════════════════════`);
L.push(`-- Funnel OS — seed. GENERATED by scripts/generate-seed.mjs — do not hand-edit.`);
L.push(`-- Reproduces the mockup's Targeted Views and By Round tabs from real rows.`);
L.push(`-- ═══════════════════════════════════════════════════════════════════════════`);
L.push(``);
L.push(`begin;`);
L.push(`delete from unmatched_rows;`);
L.push(`delete from events;`);
L.push(`delete from ads_performance;`);
L.push(`delete from import_batches;`);
L.push(`delete from contacts;`);
L.push(`delete from rounds;`);
L.push(`delete from client_journey_config;`);
L.push(``);

// journey config
L.push(`-- ── client_journey_config — the journey drives the nav and the strip ──`);
const journey = [
  ["shely", 1, "Targeted views", "ads_performance.ad_set", "Shely", "Webinar → offer · 6 stages", "targeting", "impressions", "impressions", null],
  ["shely", 2, "Ads", "ads_performance.ad", "Shely", "Webinar → offer · 6 stages", "ads", "clicks", "CTR", null],
  ["shely", 3, "Landing page", null, "Shely", "Webinar → offer · 6 stages", "lp", "leads", "opt-in", null],
  ["shely", 4, "Attend class", "rounds.session_label", "Shely", "Webinar → offer · 6 stages", "class", "attendance", "show", null],
  ["shely", 5, "Preview offer", "events.round_id", "Shely", "Webinar → offer · 6 stages", "preview", "preview_purchases", "take-up", 297],
  ["shely", 6, "Middle offer", "events.round_id", "Shely", "Webinar → offer · 6 stages", "middle", "middle_purchases", "take-up", 3000],
  ["northsea_supply", 1, "Targeted views", "ads_performance.ad_set", "Northsea Supply", "Ecommerce · 3 stages + targeting", "targeting", "impressions", "impressions", null],
  ["northsea_supply", 2, "Ads", "ads_performance.ad", "Northsea Supply", "Ecommerce · 3 stages + targeting", "ads", "clicks", "CTR", null],
  ["northsea_supply", 3, "Product page", "ads_performance.ad_set", "Northsea Supply", "Ecommerce · 3 stages + targeting", "product", "leads", "sessions", null],
  ["northsea_supply", 4, "Checkout", "events.product", "Northsea Supply", "Ecommerce · 3 stages + targeting", "checkout", "preview_purchases", "complete", 298],
];
L.push(`insert into client_journey_config (client_id, stage_order, stage_name, compare_dimension, client_name, client_note, stage_slug, stage_metric, stage_rate_label, unit_price) values`);
L.push(journey.map((r) => `  (${q(r[0])}, ${r[1]}, ${q(r[2])}, ${q(r[3])}, ${q(r[4])}, ${q(r[5])}, ${q(r[6])}, ${q(r[7])}, ${q(r[8])}, ${n(r[9])})`).join(",\n") + ";");
L.push(``);

// rounds
L.push(`-- ── rounds ──`);
const allRounds = [
  ...ROUNDS.map((r) => [r.id, CLIENT, r.start, r.end, r.session, r.label]),
  ...NS_ROUNDS.map((r) => [r.id, "northsea_supply", r.start, r.end, r.session, r.label]),
];
L.push(`insert into rounds (round_id, client_id, start_date, end_date, session_date, session_label) values`);
L.push(allRounds.map((r) => `  (${q(r[0])}, ${q(r[1])}, ${q(r[2])}, ${q(r[3])}, ${q(r[4])}, ${q(r[5])})`).join(",\n") + ";");
L.push(``);

// import batches
L.push(`-- ── import_batches — drives the staleness banner on the Import tab ──`);
const batches = [
  [batchAds, "ads", "2026-08-12 09:14+08", "2026-05-01", "2026-08-06", 1284, `{"Amount spent (SGD)":"spend","Impressions":"impressions","Reach":"reach","Outbound clicks":"clicks"}`, false, "1 day", CLIENT],
  [batchLeads, "leads", "2026-08-12 09:02+08", "2026-04-07", "2026-08-12", 972, `{"Email":"email","Phone":"phone","Created":"event_date","utm_campaign":"utm_campaign"}`, false, "1 day", CLIENT],
  [batchAtt, "attendance", "2026-08-08 18:40+08", "2026-05-19", "2026-07-28", 486, `{"Session":"round_id","Email":"email","Minutes watched":"minutes_watched"}`, true, "1 day", CLIENT],
  [batchSales, "sales", "2026-08-12 09:20+08", "2026-05-01", "2026-08-06", 46, `{"Date":"event_date","Email":"email","Product":"product","Amount":"amount"}`, false, "1 day", CLIENT],
  [nsBatchAds, "ads", "2026-08-12 08:50+08", "2026-07-01", "2026-08-18", 412, `{"Amount spent (SGD)":"spend"}`, false, "1 day", "northsea_supply"],
  [nsBatchLeads, "leads", "2026-08-12 08:55+08", "2026-07-01", "2026-08-18", 296, `{"Email":"email"}`, false, "1 day", "northsea_supply"],
  [nsBatchSales, "sales", "2026-08-12 08:58+08", "2026-07-01", "2026-08-18", 170, `{"Amount":"amount"}`, false, "1 day", "northsea_supply"],
];
L.push(`insert into import_batches (batch_id, source, imported_at, coverage_start, coverage_end, row_count, column_map, stale_flag, expected_cadence, client_id) values`);
L.push(batches.map((b) => `  (${q(b[0])}, ${q(b[1])}, ${q(b[2])}, ${q(b[3])}, ${q(b[4])}, ${b[5]}, ${q(b[6])}::jsonb, ${b[7]}, ${q(b[8])}::interval, ${q(b[9])})`).join(",\n") + ";");
L.push(``);

// contacts
L.push(`-- ── contacts (${contacts.length}) ──`);
for (const c of chunks(contacts, 400)) {
  L.push(`insert into contacts (contact_id, email, phone, client_id) values`);
  L.push(c.map((x) => `  (${q(x.id)}, ${q(x.email)}, ${q(x.phone)}, ${q(x.client_id)})`).join(",\n") + ";");
}
L.push(``);

// ads
L.push(`-- ── ads_performance (${ads.length}) ──`);
for (const c of chunks(ads, 300)) {
  L.push(`insert into ads_performance (id, round_id, date, campaign, ad_set, ad, spend, impressions, reach, clicks, import_batch_id) values`);
  L.push(c.map((x) => `  (${q(x.id)}, ${q(x.round_id)}, ${q(x.date)}, ${q(x.campaign)}, ${q(x.ad_set)}, ${q(x.ad)}, ${x.spend}, ${x.impressions}, ${x.reach}, ${x.clicks}, ${q(x.batch)})`).join(",\n") + ";");
}
L.push(``);

// events
L.push(`-- ── events (${events.length}) ──`);
for (const c of chunks(events, 400)) {
  L.push(`insert into events (event_id, contact_id, round_id, event_type, event_date, lead_round_id, close_round_id, attribution_method, utm_campaign, source, match_status, product, minutes_watched, amount, refund_amount, refund_date, is_lead, import_batch_id) values`);
  L.push(c.map((x) =>
    `  (${q(x.id)}, ${q(x.contact_id)}, ${q(x.round_id)}, ${q(x.event_type)}, ${q(x.event_date)}, ${q(x.lead_round_id)}, ${q(x.close_round_id)}, ${q(x.attribution_method)}, ${q(x.utm_campaign)}, ${q(x.source)}, ${q(x.match_status)}, ${q(x.product)}, ${n(x.minutes_watched)}, ${n(x.amount)}, ${n(x.refund_amount)}, ${q(x.refund_date)}, ${x.is_lead === null ? "NULL" : x.is_lead}, ${q(x.batch)})`
  ).join(",\n") + ";");
}
L.push(``);

// unmatched
L.push(`-- ── unmatched_rows — the Unmatched tab: 34 waiting, SGD 3,297 held, 483 auto-resolved ──`);
const unmatched = [];
const push = (source, reason, best, method, conf, held, raw, resolved = false) =>
  unmatched.push([uuid(16), source, reason, best, method, conf, held, JSON.stringify(raw), resolved]);

push("sales", "bought_without_lead", "jtan@company.com.sg", "same phone", "low", 3000, { email: "j.tan@gmail.com", amount: 3000, product: "middle" });
push("attendance", "same_person_two_addresses", "meilin.w@gmail.com", "plus-addressed alias", "high", 0, { email: "meilin.w+2@gmail.com", session: "0726-03" });
push("attendance", "phone_format", "91234567", "exact digits", "high", 0, { phone: "+65 9123 4567", session: "0726-03" });
push("attendance", "name_only", null, null, "none", 0, { name: "Sarah L.", session: "0726-02" });
push("sales", "bought_without_lead", null, null, "none", 297, { email: "raj@—.sg", amount: 297, product: "preview" });
// pad the queue out to 34 waiting, grouped by reason exactly as the mockup counts them
const REASON_COUNTS = { same_person_two_addresses: 12, phone_format: 9, name_only: 8, bought_without_lead: 5 };
const already = { same_person_two_addresses: 1, phone_format: 1, name_only: 1, bought_without_lead: 2 };
for (const [reason, total] of Object.entries(REASON_COUNTS)) {
  for (let k = already[reason]; k < total; k++) {
    const src = reason === "bought_without_lead" ? "sales" : k % 2 ? "attendance" : "leads";
    push(src, reason, reason === "name_only" ? null : `candidate${k}@example.sg`,
      reason === "name_only" ? null : "email similarity",
      reason === "name_only" ? "none" : "low", 0, { note: `parked ${reason} #${k}` });
  }
}
for (const c of chunks(unmatched, 400)) {
  L.push(`insert into unmatched_rows (row_id, source, import_batch_id, reason, best_guess, guess_method, confidence, revenue_held, raw_data, auto_resolved, resolved_at, client_id) values`);
  L.push(c.map((u) =>
    `  (${q(u[0])}, ${q(u[1])}, ${q(u[1] === "ads" ? batchAds : u[1] === "sales" ? batchSales : u[1] === "attendance" ? batchAtt : batchLeads)}, ${q(u[2])}, ${q(u[3])}, ${q(u[4])}, ${q(u[5])}, ${u[6]}, ${q(u[7])}::jsonb, ${u[8]}, ${u[8] ? "'2026-08-10 09:00+08'" : "NULL"}, ${q(CLIENT)})`
  ).join(",\n") + ";");
}
// 483 auto-resolved this week — counted, no human review. Generated rather than
// enumerated: they're a volume figure on the Unmatched tab, not 483 distinct stories.
L.push(``);
L.push(`insert into unmatched_rows (source, import_batch_id, reason, best_guess, guess_method, confidence, revenue_held, raw_data, auto_resolved, resolved_at, client_id)`);
L.push(`select`);
L.push(`  case when k % 3 = 0 then 'attendance' else 'leads' end,`);
L.push(`  case when k % 3 = 0 then ${q(batchAtt)}::uuid else ${q(batchLeads)}::uuid end,`);
L.push(`  case when k % 2 = 1 then 'phone_format' else 'same_person_two_addresses' end,`);
L.push(`  'auto' || k || '@example.sg',`);
L.push(`  case when k % 2 = 1 then 'phone normalisation' else 'plus-addressed alias' end,`);
L.push(`  'high', 0, jsonb_build_object('note', 'auto-resolved #' || k), true,`);
L.push(`  '2026-08-10 09:00+08'::timestamptz, ${q(CLIENT)}`);
L.push(`from generate_series(1, 483) as k;`);
L.push(``);
L.push(`commit;`);
L.push(``);

mkdirSync(join(ROOT, "supabase/migrations"), { recursive: true });
writeFileSync(join(ROOT, "supabase/migrations/0002_seed.sql"), L.join("\n"));

// ═══════════════════════════════════════════════════════════════════════════
// 9. SELF-CHECK — print target vs achieved so the seed is auditable
// ═══════════════════════════════════════════════════════════════════════════

const money = (x) => Number(x).toFixed(2);
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);

console.log(`\nrows: ${contacts.length} contacts · ${ads.length} ads · ${events.length} events · ${unmatched.length} unmatched\n`);

console.log("BY ROUND — spend / impressions / leads / attendance / preview / middle");
for (const r of ROUNDS) {
  const a = ads.filter((x) => x.round_id === r.id);
  const ev = events.filter((x) => x.lead_round_id === r.id);
  const evR = events.filter((x) => x.round_id === r.id);
  const got = {
    spend: money(sum(a, (x) => Number(x.spend))),
    impr: sum(a, (x) => x.impressions),
    leads: evR.filter((x) => x.event_type === "lead").length,
    att: evR.filter((x) => x.event_type === "attendance").length,
    prev: ev.filter((x) => x.event_type === "sale" && x.product === "preview").length,
    mid: ev.filter((x) => x.event_type === "sale" && x.product === "middle").length,
  };
  const want = r.adsOnly
    ? { spend: money(r.spend), impr: r.impr, leads: 0, att: 0, prev: 0, mid: 0 }
    : { spend: money(r.spend), impr: r.impr, leads: r.leads, att: r.att, prev: r.prevBuy, mid: r.midBuy };
  const ok = Object.keys(want).every((k) => String(want[k]) === String(got[k])) ? "OK " : "DIFF";
  console.log(`  ${ok} ${r.id}  want ${Object.values(want).join(" / ")}   got ${Object.values(got).join(" / ")}`);
}

console.log("\nTARGETED VIEWS — spend / impressions / clicks / leads / attendance / preview / middle");
for (const aud of AUDIENCES) {
  const a = ads.filter((x) => x.ad_set === aud.name && x.campaign.startsWith("Shely"));
  const ev = events.filter((x) => x.utm_campaign === aud.name);
  const got = {
    spend: money(sum(a, (x) => Number(x.spend))),
    impr: sum(a, (x) => x.impressions),
    clicks: sum(a, (x) => x.clicks),
    leads: ev.filter((x) => x.event_type === "lead").length,
    att: ev.filter((x) => x.event_type === "attendance").length,
    prev: ev.filter((x) => x.event_type === "sale" && x.product === "preview").length,
    mid: ev.filter((x) => x.event_type === "sale" && x.product === "middle").length,
  };
  const want = { spend: money(aud.spend), impr: aud.impr, clicks: aud.clicks, leads: aud.leads, att: aud.att, prev: aud.prevBuy, mid: aud.midBuy };
  const ok = Object.keys(want).every((k) => String(want[k]) === String(got[k])) ? "OK " : "DIFF";
  console.log(`  ${ok} ${aud.name.padEnd(26)} want ${Object.values(want).join(" / ")}   got ${Object.values(got).join(" / ")}`);
}

const shelyAds = ads.filter((x) => x.campaign.startsWith("Shely"));
console.log(`\nTOTALS  spend ${money(sum(shelyAds, (x) => Number(x.spend)))} (mockup 12897.14) · impressions ${sum(shelyAds, (x) => x.impressions)} (mockup 248692) · clicks ${sum(shelyAds, (x) => x.clicks)} (mockup 3790)`);
console.log(`        reach ${sum(shelyAds, (x) => x.reach)} (mockup 210110 — see note on April in this file)`);
