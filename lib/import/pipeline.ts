import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/supabase/admin";
import { parseCsv, toNumber, toDate, toTimestamp, type Row } from "./csv";
import { SOURCES, mapColumns, type SourceKey } from "./sources";
import { buildIndex, matchRow, normEmail, normPhone, type KnownContact } from "./identity";
import { attributeLead, closeRoundFor, resolveRoundRef, resolveProduct, type Round, type AdSetRun } from "./attribute";

/**
 * The pass, as the workflow doc specifies it:
 *
 *   1 IMPORT     parse, map columns (remembered per source, breaks loudly)
 *   2 MATCH      exact / auto-resolved / parked
 *   3 ATTRIBUTE  lead_round_id + how it was decided; close_round_id for sales
 *   4 DIFF       new rows, changed rows, restatement warnings
 *   5 COMMIT     written only on approval
 *
 * Steps 1–4 run in `planImport` and write nothing. Step 5 is `commitPlan`.
 * The plan is persisted on the batch so the diff you approve is the diff that
 * gets applied — not a re-parse that might differ.
 */

export type Plan = {
  source: SourceKey;
  clientId: string;
  fileName: string;
  columnMap: Record<string, string>;
  unusedColumns: string[];
  rowCount: number;
  coverage: { start: string | null; end: string | null };
  counts: {
    matchedExact: number;
    matchedAuto: number;
    newContacts: number;
    parked: number;
    duplicates: number;
  };
  attribution: { utm: number; dateWindow: number; none: number };
  diff: { newRows: number; changedRows: number; restatements: string[] };
  warnings: string[];
  ops: {
    contacts: Array<{ contact_id: string; email: string | null; phone: string | null; client_id: string }>;
    events: Array<Record<string, unknown>>;
    ads: Array<Record<string, unknown>>;
    unmatched: Array<Record<string, unknown>>;
    refundUpdates: Array<{ event_id: string; refund_amount: number; refund_date: string | null }>;
  };
};

export class ImportError extends Error {
  constructor(message: string, readonly detail?: string[]) { super(message); }
}

const uuid = () => crypto.randomUUID();
const dayOf = (s: string | null) => (s ? s.slice(0, 10) : null);

/**
 * Identity of a parked row, so the same bad row isn't parked twice.
 *
 * Keyed on the row's own values rather than a database id, because on a
 * re-upload the row is a fresh object with a fresh uuid — nothing about it is
 * stable except what it says. Keys are sorted so a reordered export still
 * matches.
 */
const parkKey = (raw: unknown) => {
  const o = (raw ?? {}) as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(o).sort().map((k) => [k, String(o[k] ?? "").trim()]),
  );
};

/**
 * A file none of whose rows could be used is refused rather than staged.
 *
 * Meta exports an empty report as one row reading "No data available.", which
 * parses cleanly, maps cleanly, and produces nothing — so the app would offer a
 * commit button that writes zero rows and then mark the source freshly imported.
 */
function refuseIfNothingUsable(unusable: number, total: number, label: string) {
  if (total > 0 && unusable === total) {
    throw new ImportError(
      `Nothing in that ${label} file could be used — all ${total} row${total === 1 ? "" : "s"} were skipped.`,
      [
        "Every row was missing a usable date, or fell outside every round's window.",
        'An export with no rows in it — Meta writes "No data available." — looks like this.',
      ],
    );
  }
}

export async function planImport(
  db: SupabaseClient,
  { source, clientId, fileName, text }: { source: SourceKey; clientId: string; fileName: string; text: string },
): Promise<Plan> {
  const spec = SOURCES[source];
  if (!spec) throw new ImportError(`Unknown source "${source}".`);

  // ── 1. IMPORT ────────────────────────────────────────────────────────────
  const { headers, rows } = parseCsv(text);
  if (!rows.length) throw new ImportError("That file has no data rows.");

  const { data: remembered } = await db
    .from("v_column_map").select("column_map").eq("client_id", clientId).eq("source", source).maybeSingle();

  const { map, missing, broken, unused } = mapColumns(source, headers, remembered?.column_map ?? null);

  if (missing.length) {
    throw new ImportError(
      `The column mapping for ${spec.label} is broken — refusing to import rather than write blanks.`,
      [
        ...missing.map((m) => `Required field "${m}" has no matching column.`),
        `Headers found: ${headers.join(" · ")}`,
      ],
    );
  }

  const warnings: string[] = [];
  if (broken.length) warnings.push(`Column mapping changed since the last import — ${broken.join("; ")}`);

  const val = (r: Row, field: string) => (map[field] ? r[map[field]] ?? null : null);

  // ── reference data ───────────────────────────────────────────────────────
  const rounds = await fetchAll<Round>(db, "rounds", "round_id, client_id, start_date, end_date, session_date",
    (q) => q.eq("client_id", clientId));
  if (!rounds.length) throw new ImportError("This client has no rounds yet — create a round before importing.");

  const roundIds = rounds.map((r) => r.round_id);

  const plan: Plan = {
    source, clientId, fileName, columnMap: map, unusedColumns: unused,
    rowCount: rows.length,
    coverage: { start: null, end: null },
    counts: { matchedExact: 0, matchedAuto: 0, newContacts: 0, parked: 0, duplicates: 0 },
    attribution: { utm: 0, dateWindow: 0, none: 0 },
    diff: { newRows: 0, changedRows: 0, restatements: [] },
    warnings,
    ops: { contacts: [], events: [], ads: [], unmatched: [], refundUpdates: [] },
  };

  const dates: string[] = [];
  const track = (d: string | null) => { if (d) dates.push(d); };

  // Rows the file could not be used for at all — not written, not parked, not
  // even recognised as something seen before. A file where EVERY row lands here
  // isn't an import, and offering a commit button for it is a lie.
  let unusable = 0;

  // ══ ADS — no person, so it skips match + attribute entirely ══════════════
  if (source === "ads") {
    const existing = await fetchAll<{ round_id: string; date: string; ad_set: string | null; ad: string | null }>(
      db, "ads_performance", "round_id, date, ad_set, ad", (q) => q.in("round_id", roundIds));
    const seen = new Set(existing.map((e) => `${e.round_id}|${e.date}|${e.ad_set ?? ""}|${e.ad ?? ""}`));

    for (const r of rows) {
      const date = toDate(val(r, "date"));
      if (!date) { unusable++; continue; }
      track(date);

      // the round is the one whose window contains the spend date
      const round = rounds.find((x) => dayOf(x.start_date)! <= date && date <= dayOf(x.end_date)!);
      if (!round) {
        warnings.push(`No round covers ${date} — ${rows.length > 1 ? "some ads rows" : "that row"} would have no round.`);
        unusable++;
        continue;
      }
      const adSet = val(r, "ad_set");
      const ad = val(r, "ad");
      const key = `${round.round_id}|${date}|${adSet ?? ""}|${ad ?? ""}`;
      if (seen.has(key)) { plan.counts.duplicates++; continue; }
      seen.add(key);

      plan.ops.ads.push({
        id: uuid(), round_id: round.round_id, date,
        campaign: val(r, "campaign"), ad_set: adSet, ad,
        spend: toNumber(val(r, "spend")) ?? 0,
        impressions: Math.round(toNumber(val(r, "impressions")) ?? 0),
        reach: Math.round(toNumber(val(r, "reach")) ?? 0),
        clicks: Math.round(toNumber(val(r, "clicks")) ?? 0),
      });
      plan.diff.newRows++;
    }

    plan.coverage = { start: dates.sort()[0] ?? null, end: dates.sort().slice(-1)[0] ?? null };
    refuseIfNothingUsable(unusable, rows.length, spec.label);
    plan.warnings = [...new Set(plan.warnings)];
    return plan;
  }

  // ══ PEOPLE SOURCES ═══════════════════════════════════════════════════════
  const contacts = await fetchAll<KnownContact>(db, "contacts", "contact_id, email, phone",
    (q) => q.eq("client_id", clientId));
  const index = buildIndex(contacts);

  const events = await fetchAll<{
    event_id: string; contact_id: string | null; round_id: string | null; event_type: string;
    event_date: string; product: string | null; amount: string | null; refund_amount: string | null;
    lead_round_id: string | null; source: string | null;
  }>(db, "events",
    "event_id, contact_id, round_id, event_type, event_date, product, amount, refund_amount, lead_round_id, source",
    (q) => q.in("round_id", roundIds));

  const adRuns = await fetchAll<AdSetRun>(db, "ads_performance", "ad_set, round_id, date",
    (q) => q.in("round_id", roundIds).not("ad_set", "is", null));

  const attendancesByContact = new Map<string, Array<{ round_id: string | null; event_date: string }>>();
  const leadRoundByContact = new Map<string, string>();
  const leadSourceByContact = new Map<string, string>();
  for (const e of events) {
    if (!e.contact_id) continue;
    if (e.event_type === "attendance") {
      const list = attendancesByContact.get(e.contact_id) ?? [];
      list.push({ round_id: e.round_id, event_date: e.event_date });
      attendancesByContact.set(e.contact_id, list);
    }
    if (e.event_type === "lead" && e.lead_round_id) {
      leadRoundByContact.set(e.contact_id, e.lead_round_id);
      if (e.source) leadSourceByContact.set(e.contact_id, e.source);
    }
  }

  // dedupe key per event type
  const eventKey = (t: string, contactId: string, roundId: string | null, date: string, product?: string | null) =>
    `${t}|${contactId}|${roundId ?? ""}|${dayOf(date)}|${product ?? ""}`;
  const seenEvents = new Set(
    events.map((e) => eventKey(e.event_type, e.contact_id ?? "", e.round_id, e.event_date, e.product)),
  );

  // newly created contacts are matchable by later rows in the SAME file
  const addContact = (email: string | null, phone: string | null) => {
    const id = uuid();
    plan.ops.contacts.push({ contact_id: id, email, phone, client_id: clientId });
    if (email) { index.byEmail.set(email, id); index.byPlusStripped.set(email, id); }
    if (phone) { index.byPhone.set(phone, id); index.byDigits.set(phone.replace(/\D/g, "").slice(-8), id); }
    plan.counts.newContacts++;
    return id;
  };

  // A row that's already sitting in the queue must not be parked again. Without
  // this, re-uploading the same file doubles the queue every time — and the
  // queue is the number every figure in the app is understated by, so it has to
  // mean "rows waiting", not "times a row was seen".
  const stillParked = await fetchAll<{ raw_data: unknown }>(
    db, "unmatched_rows", "raw_data",
    (q) => q.eq("client_id", clientId).eq("source", source).is("resolved_at", null),
  );
  const parked = new Set(stillParked.map((u) => parkKey(u.raw_data)));

  const park = (reason: string, raw: Row, bestGuess: string | null, guessMethod: string | null, confidence: string, held = 0) => {
    const key = parkKey(raw);
    if (parked.has(key)) { plan.counts.duplicates++; return; }
    parked.add(key);
    plan.ops.unmatched.push({
      row_id: uuid(), source, client_id: clientId, raw_data: raw,
      reason, best_guess: bestGuess, guess_method: guessMethod, confidence,
      revenue_held: held, auto_resolved: false,
    });
    plan.counts.parked++;
  };

  for (const r of rows) {
    const email = normEmail(val(r, "email"));
    const phone = normPhone(val(r, "phone"));
    const outcome = matchRow(index, val(r, "email"), val(r, "phone"), source === "leads");

    let contactId: string | null = null;
    if (outcome.kind === "exact") { contactId = outcome.contactId; plan.counts.matchedExact++; }
    else if (outcome.kind === "auto") { contactId = outcome.contactId; plan.counts.matchedAuto++; }
    else if (outcome.kind === "new") { contactId = addContact(email, phone); }

    // ── LEADS ──────────────────────────────────────────────────────────────
    if (source === "leads") {
      if (!contactId) {
        park(outcome.kind === "park" ? outcome.reason : "name_only", r, null, null, "none");
        continue;
      }
      const when = toTimestamp(val(r, "event_date"));
      if (!when) { park("name_only", r, null, "no usable opt-in date", "none"); continue; }
      track(dayOf(when));

      const utm = val(r, "utm_campaign");
      const { roundId, method } = attributeLead(when, utm, rounds, adRuns);
      if (method === "utm") plan.attribution.utm++;
      else if (method === "date_window") plan.attribution.dateWindow++;
      else plan.attribution.none++;

      if (!roundId) { park("name_only", r, null, "no round covers this opt-in date", "none"); continue; }

      const key = eventKey("lead", contactId, roundId, when);
      if (seenEvents.has(key)) { plan.counts.duplicates++; continue; }
      seenEvents.add(key);

      const src = val(r, "source") || (utm ? "Paid Ads" : "Organic");
      plan.ops.events.push({
        event_id: uuid(), contact_id: contactId, round_id: roundId, event_type: "lead",
        event_date: when, lead_round_id: roundId, attribution_method: method,
        utm_campaign: utm || null, source: src, match_status: outcome.kind === "auto" ? "auto_resolved" : "matched",
      });
      plan.diff.newRows++;
      continue;
    }

    // ── ATTENDANCE ─────────────────────────────────────────────────────────
    if (source === "attendance") {
      if (!contactId) {
        const o = outcome as Extract<typeof outcome, { kind: "park" }>;
        park(o.reason, r, o.bestGuess, o.guessMethod, o.confidence);
        continue;
      }
      const ref = val(r, "round_id");
      const roundId = ref ? resolveRoundRef(ref, rounds) : null;
      if (!roundId) { park("name_only", r, null, `no round matches session "${ref ?? ""}"`, "none"); continue; }

      const round = rounds.find((x) => x.round_id === roundId)!;
      const when = toTimestamp(val(r, "event_date")) ?? new Date(`${dayOf(round.session_date ?? round.end_date)}T20:00:00Z`).toISOString();
      track(dayOf(when));

      const key = eventKey("attendance", contactId, roundId, when);
      if (seenEvents.has(key)) { plan.counts.duplicates++; continue; }
      seenEvents.add(key);

      plan.ops.events.push({
        event_id: uuid(), contact_id: contactId, round_id: roundId, event_type: "attendance",
        event_date: when,
        lead_round_id: leadRoundByContact.get(contactId) ?? null,
        source: leadSourceByContact.get(contactId) ?? null,
        minutes_watched: Math.round(toNumber(val(r, "minutes_watched")) ?? 0) || null,
        match_status: outcome.kind === "auto" ? "auto_resolved" : "matched",
      });
      // attendance changes this contact's close_round_id for any later purchase
      const list = attendancesByContact.get(contactId) ?? [];
      list.push({ round_id: roundId, event_date: when });
      attendancesByContact.set(contactId, list);
      plan.diff.newRows++;
      continue;
    }

    // ── SALES ──────────────────────────────────────────────────────────────
    if (source === "sales") {
      const when = toTimestamp(val(r, "event_date"));
      const amount = toNumber(val(r, "amount"));
      const productRaw = val(r, "product") ?? "";
      const product = resolveProduct(productRaw);
      const refund = toNumber(val(r, "refund_amount")) ?? 0;
      const refundDate = toDate(val(r, "refund_date"));

      if (!when || amount === null) { park("name_only", r, null, "missing date or amount", "none"); continue; }
      if (!product) {
        warnings.push(`Product "${productRaw}" isn't recognised as preview or middle — that row was parked.`);
        park("name_only", r, null, `unrecognised product "${productRaw}"`, "none", amount);
        continue;
      }
      track(dayOf(when));

      // Revenue with no person attached is held, never credited to a round.
      if (!contactId) {
        const o = outcome as Extract<typeof outcome, { kind: "park" }>;
        park(o.reason, r, o.bestGuess, o.guessMethod, o.confidence, amount);
        continue;
      }

      // A lead event is what makes revenue attributable. Without one the sale is
      // real but has no spend behind it — counted in revenue, excluded from ROAS.
      const leadRound = leadRoundByContact.get(contactId) ?? null;
      const closeRound = closeRoundFor(when, attendancesByContact.get(contactId) ?? []);
      const purchaseRound =
        closeRound ??
        leadRound ??
        rounds.find((x) => dayOf(x.start_date)! <= dayOf(when)! && dayOf(when)! <= dayOf(x.end_date)!)?.round_id ??
        null;

      if (!purchaseRound) { park("bought_without_lead", r, null, "no round covers this purchase", "none", amount); continue; }

      // RESTATEMENT: this sale already exists and the file changes it.
      const prior = events.find(
        (e) => e.event_type === "sale" && e.contact_id === contactId &&
               e.product === product && dayOf(e.event_date) === dayOf(when),
      );
      if (prior) {
        const priorRefund = Number(prior.refund_amount ?? 0);
        if (refund !== priorRefund) {
          plan.ops.refundUpdates.push({ event_id: prior.event_id, refund_amount: refund, refund_date: refundDate });
          plan.diff.changedRows++;
          plan.diff.restatements.push(
            `would restate ${prior.lead_round_id ?? prior.round_id} revenue by ${(priorRefund - refund).toFixed(2)} — refund on ${productRaw} — review`,
          );
        } else {
          plan.counts.duplicates++;
        }
        continue;
      }

      const key = eventKey("sale", contactId, purchaseRound, when, product);
      if (seenEvents.has(key)) { plan.counts.duplicates++; continue; }
      seenEvents.add(key);

      plan.ops.events.push({
        event_id: uuid(), contact_id: contactId, round_id: purchaseRound, event_type: "sale",
        event_date: when, product, amount,
        refund_amount: refund, refund_date: refundDate,
        // revenue credited to the round that produced the lead; closing credit to
        // the class actually attended. Both true, both reconcile to one total.
        lead_round_id: leadRound,
        close_round_id: closeRound,
        source: leadSourceByContact.get(contactId) ?? null,
        is_lead: Boolean(leadRound),
        match_status: outcome.kind === "auto" ? "auto_resolved" : "matched",
      });
      plan.diff.newRows++;
      if (!leadRound) {
        warnings.push("At least one sale has no lead event — counted in revenue, excluded from ROAS.");
      }
    }
  }

  const sorted = dates.sort();
  plan.coverage = { start: sorted[0] ?? null, end: sorted[sorted.length - 1] ?? null };
  plan.warnings = [...new Set(plan.warnings)];
  plan.diff.restatements = [...new Set(plan.diff.restatements)];
  return plan;
}

/** Step 5 — writes the approved plan. Nothing before this touches the data. */
export async function commitPlan(db: SupabaseClient, batchId: string, plan: Plan) {
  const chunk = <T,>(a: T[], n = 500) =>
    Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

  for (const part of chunk(plan.ops.contacts)) {
    const { error } = await db.from("contacts").insert(part);
    if (error) throw new ImportError(`Writing contacts failed: ${error.message}`);
  }
  for (const part of chunk(plan.ops.ads.map((a) => ({ ...a, import_batch_id: batchId })))) {
    const { error } = await db.from("ads_performance").insert(part);
    if (error) throw new ImportError(`Writing ads_performance failed: ${error.message}`);
  }
  for (const part of chunk(plan.ops.events.map((e) => ({ ...e, import_batch_id: batchId })))) {
    const { error } = await db.from("events").insert(part);
    if (error) throw new ImportError(`Writing events failed: ${error.message}`);
  }
  for (const part of chunk(plan.ops.unmatched.map((u) => ({ ...u, import_batch_id: batchId })))) {
    const { error } = await db.from("unmatched_rows").insert(part);
    if (error) throw new ImportError(`Parking unmatched rows failed: ${error.message}`);
  }
  for (const u of plan.ops.refundUpdates) {
    const { error } = await db.from("events")
      .update({ refund_amount: u.refund_amount, refund_date: u.refund_date })
      .eq("event_id", u.event_id);
    if (error) throw new ImportError(`Applying a refund failed: ${error.message}`);
  }

  const { error } = await db.from("import_batches").update({
    status: "committed",
    committed_at: new Date().toISOString(),
    staged_payload: null,       // the plan is spent; keep the summary, drop the rows
    coverage_start: plan.coverage.start,
    coverage_end: plan.coverage.end,
    row_count: plan.rowCount,
    stale_flag: false,
  }).eq("batch_id", batchId);
  if (error) throw new ImportError(`Closing the batch failed: ${error.message}`);
}
