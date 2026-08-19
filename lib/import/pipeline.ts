import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/supabase/admin";
import { parseCsv, toNumber, toDate, toTimestamp, localDay, type Row } from "./csv";
import { SOURCES, mapColumns, type SourceKey } from "./sources";
import { buildIndex, matchRow, normEmail, normPhone, type KnownContact, type ParkReason } from "./identity";
import { attributeLead, closeRoundFor, resolveRoundRef, resolveProduct, roundFromCampaign, type Round, type AdSetRun } from "./attribute";

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
  /**
   * The file this one needed committed first, if it hasn't been.
   *
   * A preview is computed against what is IN the database, not against the
   * other files sitting on the same screen. Drop all four at once on an empty
   * database and every preview is honest and every one is wrong: leads have no
   * ad sets to match, so all of them fall back to date-window attribution;
   * attendance and sales have no people to attach to, so every row parks.
   *
   * The counts already say so — "0 by ad set", "169 parked" — but they read as
   * a fact about the file rather than about the order it was dropped in, and
   * the Commit button sits there either way. This names the cause.
   *
   * A warning rather than a refusal: importing attendance for people who never
   * came through a form is a real thing to want, and re-importing after the
   * missing file lands supersedes the parked rows rather than duplicating them.
   */
  prerequisite: string | null;
  ops: {
    contacts: Array<{ contact_id: string; email: string | null; phone: string | null; client_id: string }>;
    events: Array<Record<string, unknown>>;
    ads: Array<Record<string, unknown>>;
    unmatched: Array<Record<string, unknown>>;
    refundUpdates: Array<{ event_id: string; refund_amount: number; refund_date: string | null }>;
    /**
     * Parked rows this import has just made countable.
     *
     * Adding phone matching to sales means a row that parked last week matches
     * this week. Without this, re-uploading the fixed file writes the event AND
     * leaves the old row sitting in the queue holding its 297 — so the money is
     * counted in revenue and still counted as missing. "Understated by exactly
     * this queue" has to keep being true after a re-upload, not just after the
     * first one.
     */
    supersededParked: Array<{ row_id: string; contact_id: string }>;
    /**
     * Parked rows this import has seen again and still cannot match.
     *
     * They keep their place in the queue and move onto this batch, so the
     * batch they came from can be retired whole without taking them with it.
     */
    adoptedParked: string[];
  };
};

export class ImportError extends Error {
  constructor(message: string, readonly detail?: string[]) { super(message); }
}

const uuid = () => crypto.randomUUID();
/** Round a count, but keep "the export didn't say" distinct from "zero". */
const round0 = (n: number | null) => (n === null ? null : Math.round(n));
/** For a plain date column — rounds carry local calendar dates already. */
const dayOf = (s: string | null) => (s ? s.slice(0, 10) : null);
/** For an INSTANT — the day it falls on locally, not in UTC. See localDay. */
const sgDayOf = (s: string | null) => (s ? localDay(s) : null);

/**
 * Identity of a parked row, so the same bad row isn't parked twice.
 *
 * Keyed on the row's own values rather than a database id, because on a
 * re-upload the row is a fresh object with a fresh uuid — nothing about it is
 * stable except what it says. Keys are sorted so a reordered export still
 * matches.
 */
/**
 * The platform an ads file is read as when it doesn't say.
 *
 * Meta's export names Meta nowhere in the file, so requiring the column would
 * refuse every export anyone actually has. Assuming it is the pragmatic call —
 * but the assumption is announced on the preview, never made in the database,
 * which is why ads_performance.channel has no DEFAULT.
 */
const ASSUMED_CHANNEL = "meta";

/** meta / google / tiktok, however the file spells it. */
function normChannel(raw: string | null): string {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return ASSUMED_CHANNEL;
  if (s.includes("meta") || s.includes("facebook") || s.includes("instagram")) return "meta";
  if (s.includes("google") || s.includes("youtube") || s.includes("adwords")) return "google";
  if (s.includes("tiktok")) return "tiktok";
  return "other";
}

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
  { source, clientId, fileName, text, asContactId }: {
    source: SourceKey; clientId: string; fileName: string; text: string;
    /**
     * Resolving a parked row: the human has said who this is, so skip matching
     * and use this contact for every row.
     *
     * Resolution has to produce the SAME event an ordinary import would have —
     * same round attribution, same closing credit, same dedupe, same
     * restatement check. The only thing that was ever missing is the identity,
     * so that is the only thing supplied. Everything downstream is the real
     * import path, which is why the queue can't drift away from the importer.
     */
    asContactId?: string;
  },
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

  /**
   * A mapped cell, or null.
   *
   * An empty cell is ABSENT, not an empty value. Returning "" put a Meta export
   * with a blank Ad set name into ads_performance as ad_set = '', which is not
   * null, so Targeted views grew an audience whose name was the empty string —
   * a column with no header holding every dollar of spend.
   */
  const val = (r: Row, field: string) => {
    const raw = map[field] ? r[map[field]] : undefined;
    const s = raw?.trim();
    return s ? s : null;
  };

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
    prerequisite: null,
    ops: { contacts: [], events: [], ads: [], unmatched: [], refundUpdates: [], supersededParked: [], adoptedParked: [] },
  };

  const dates: string[] = [];
  const track = (d: string | null) => { if (d) dates.push(d); };

  // Rows the file could not be used for at all — not written, not parked, not
  // even recognised as something seen before. A file where EVERY row lands here
  // isn't an import, and offering a commit button for it is a lie.
  let unusable = 0;

  // ══ ADS — no person, so it skips match + attribute entirely ══════════════
  if (source === "ads") {
    /**
     * The identity of an ads row is round + day + WHICH SLICE OF THE ACCOUNT.
     *
     * campaign belongs in that key. A campaign-level export has no ad set and no
     * ad name, so without it every campaign running on the same day collapses to
     * one key and all but the first are silently counted as duplicates. On a real
     * 75-row export that landed 10 rows, discarded 50, and reported 0526-02's
     * spend as 0.00 — a wrong number arrived at through a code path whose whole
     * job is to stop the same row being counted twice.
     */
    const existing = await fetchAll<{ round_id: string; date: string; campaign: string | null; ad_set: string | null; ad: string | null }>(
      db, "ads_performance", "round_id, date, campaign, ad_set, ad", (q) => q.in("round_id", roundIds));
    const adsKey = (roundId: string, date: string, campaign: string | null, adSet: string | null, ad: string | null) =>
      `${roundId}|${date}|${campaign ?? ""}|${adSet ?? ""}|${ad ?? ""}`;
    const seen = new Set(existing.map((e) => adsKey(e.round_id, e.date, e.campaign, e.ad_set, e.ad)));

    for (const r of rows) {
      const date = toDate(val(r, "date"));
      if (!date) { unusable++; continue; }
      track(date);
      // a period-level export's window ends later than its start date, and the
      // batch's coverage should say so
      track(toDate(val(r, "date_end")));

      const adSet = val(r, "ad_set");
      const ad = val(r, "ad");
      const campaign = val(r, "campaign");

      /**
       * The round is the one whose window contains the spend date — unless the
       * date belongs to no round, which is what a period-level export looks
       * like: every row dated to the first day of the reporting window. The
       * campaign name then carries the round, and using it is not a fallback so
       * much as the better key, since it is what the ad account itself records.
       */
      const round =
        rounds.find((x) => dayOf(x.start_date)! <= date && date <= dayOf(x.end_date)!) ??
        roundFromCampaign(campaign, rounds);
      if (!round) {
        warnings.push(
          `No round covers ${date}${campaign ? ` and no round is named in "${campaign}"` : ""} — ` +
          `${rows.length > 1 ? "some ads rows" : "that row"} would have no round.`,
        );
        unusable++;
        continue;
      }
      const key = adsKey(round.round_id, date, campaign, adSet, ad);
      if (seen.has(key)) { plan.counts.duplicates++; continue; }
      seen.add(key);

      plan.ops.ads.push({
        id: uuid(), round_id: round.round_id, date,
        campaign, ad_set: adSet, ad,
        // spend is required, and Meta writes an explicit 0 for a day that spent
        // nothing — so 0 there is a measurement. The other three are optional:
        // a blank cell means the export didn't say, and storing that as 0 makes
        // every audience in an export without a clicks column read "Outbound CTR
        // 0.00%" and "Reach 0" — measurements, both false. Null sums away
        // cleanly, so a round total built from one row that HAS clicks and sixty
        // that don't still comes to the right number.
        spend: toNumber(val(r, "spend")) ?? 0,
        impressions: round0(toNumber(val(r, "impressions"))),
        reach: round0(toNumber(val(r, "reach"))),
        clicks: round0(toNumber(val(r, "clicks"))),
        channel: normChannel(val(r, "channel")),
      });
      plan.diff.newRows++;
    }

    /**
     * If no row named a platform, the whole file is being read as Meta — say so
     * on the preview rather than letting the database decide silently. This is
     * the only assumption the ads importer makes, and the day a Google export
     * arrives without a platform column is the day it needs to be visible.
     */
    if (!plan.ops.ads.some((a) => a.channel !== ASSUMED_CHANNEL)) {
      plan.warnings.push(
        `No platform column found — every row is being recorded as ${ASSUMED_CHANNEL}. ` +
        `Add a "channel" column if this export is from somewhere else.`,
      );
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

  // ── Was the file this one depends on actually committed? ─────────────────
  // Skipped for the unmatched-queue replay, which imports one already-known
  // person and legitimately has no interest in what else is in the database.
  if (!asContactId) {
    if (source === "leads" && !adRuns.length) {
      plan.prerequisite =
        "No ads have been committed yet, so there are no ad sets to match a lead against. " +
        "Every row here will be attributed by date window — the round whose dates happen to " +
        "contain the opt-in — which is a guess, and Targeted views will be empty. " +
        "Commit the ads file first, then drop this one again.";
    } else if ((source === "attendance" || source === "sales") && !contacts.length) {
      plan.prerequisite =
        "No people exist yet. " +
        (source === "attendance" ? "An attendee" : "A buyer") +
        " is attached to a person, and a person only becomes known when their lead row lands — " +
        "so every row here will park instead of being counted. " +
        "Commit the leads file first, then drop this one again.";
    }
  }

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
    `${t}|${contactId}|${roundId ?? ""}|${sgDayOf(date)}|${product ?? ""}`;
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
  const stillParked = await fetchAll<{ row_id: string; raw_data: unknown }>(
    db, "unmatched_rows", "row_id, raw_data",
    (q) => q.eq("client_id", clientId).eq("source", source).is("resolved_at", null),
  );
  const parkedRowIds = new Map(stillParked.map((u) => [parkKey(u.raw_data), u.row_id]));
  const parked = new Set(parkedRowIds.keys());

  /** This exact row is in the queue, and this import can finally count it. */
  const supersede = (raw: Row, contactId: string) => {
    const rowId = parkedRowIds.get(parkKey(raw));
    if (rowId) plan.ops.supersededParked.push({ row_id: rowId, contact_id: contactId });
  };

  const park = (reason: ParkReason, raw: Row, bestGuess: string | null, guessMethod: string | null, confidence: string, held = 0) => {
    const key = parkKey(raw);
    if (parked.has(key)) {
      plan.counts.duplicates++;
      // Still in the queue and still unmatched, so this import re-asserts it
      // rather than adding a second copy. Moving it onto this batch is what
      // lets commitPlan retire the batch it replaces without dropping a row
      // that only survives in the older one.
      const existing = parkedRowIds.get(key);
      if (existing) plan.ops.adoptedParked.push(existing);
      return;
    }
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
    const outcome = asContactId
      ? ({ kind: "exact", contactId: asContactId } as const)
      : matchRow(index, val(r, "email"), val(r, "phone"), source === "leads");

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
      if (!when) { park("incomplete_row", r, null, "no usable opt-in date", "none"); continue; }
      track(sgDayOf(when));

      // The audience is what bridges a person to spend, so it is what decides
      // the round. utm_campaign names the round's campaign, not an ad set.
      const adSet = val(r, "ad_set");
      const adName = val(r, "ad");
      const utm = val(r, "utm_campaign");
      const { roundId, method } = attributeLead(when, adSet, rounds, adRuns);
      if (method === "utm") plan.attribution.utm++;
      else if (method === "date_window") plan.attribution.dateWindow++;
      else plan.attribution.none++;

      if (!roundId) { park("no_matching_round", r, null, "no round covers this opt-in date", "none"); continue; }

      const key = eventKey("lead", contactId, roundId, when);
      if (seenEvents.has(key)) { plan.counts.duplicates++; continue; }
      seenEvents.add(key);

      const src = val(r, "source") || (adSet ? "Paid Ads" : "Organic");
      plan.ops.events.push({
        event_id: uuid(), contact_id: contactId, round_id: roundId, event_type: "lead",
        event_date: when, lead_round_id: roundId, attribution_method: method,
        utm_campaign: utm || null, ad_set: adSet, ad: adName,
        source: src, match_status: outcome.kind === "auto" ? "auto_resolved" : "matched",
      });
      supersede(r, contactId);
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
      if (!roundId) { park("no_matching_round", r, null, `no round matches session "${ref ?? ""}"`, "none"); continue; }

      const round = rounds.find((x) => x.round_id === roundId)!;
      const when = toTimestamp(val(r, "event_date")) ?? new Date(`${dayOf(round.session_date ?? round.end_date)}T20:00:00+08:00`).toISOString();
      track(sgDayOf(when));

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
      supersede(r, contactId);
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

      if (!when || amount === null) { park("incomplete_row", r, null, "missing date or amount", "none"); continue; }
      if (!product) {
        warnings.push(`Product "${productRaw}" isn't recognised as preview or middle — that row was parked.`);
        park("incomplete_row", r, null, `unrecognised product "${productRaw}"`, "none", amount);
        continue;
      }
      track(sgDayOf(when));

      // Revenue with no person attached is held, never credited to a round.
      if (!contactId) {
        const o = outcome as Extract<typeof outcome, { kind: "park" }>;
        // Revenue from someone with no lead behind it is the one the Unmatched
        // tab calls out by name, so it keeps its own reason.
        const why: ParkReason = o.reason === "unknown_person" ? "bought_without_lead" : o.reason;
        park(why, r, o.bestGuess, o.guessMethod, o.confidence, amount);
        continue;
      }

      // A lead event is what makes revenue attributable. Without one the sale is
      // real but has no spend behind it — counted in revenue, excluded from ROAS.
      const leadRound = leadRoundByContact.get(contactId) ?? null;
      const closeRound = closeRoundFor(when, attendancesByContact.get(contactId) ?? []);
      const purchaseRound =
        closeRound ??
        leadRound ??
        rounds.find((x) => dayOf(x.start_date)! <= sgDayOf(when)! && sgDayOf(when)! <= dayOf(x.end_date)!)?.round_id ??
        null;

      if (!purchaseRound) { park("bought_without_lead", r, null, "no round covers this purchase", "none", amount); continue; }

      // RESTATEMENT: this sale already exists and the file changes it.
      const prior = events.find(
        (e) => e.event_type === "sale" && e.contact_id === contactId &&
               e.product === product && sgDayOf(e.event_date) === sgDayOf(when),
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
      supersede(r, contactId);
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

  // Rows that were waiting in the queue and have just been written for real.
  // Left alone they would hold revenue that is now counted, which would make
  // the app overstate what it is missing — the one direction the queue is
  // supposed to make impossible.
  for (const sup of plan.ops.supersededParked) {
    const { error } = await db.from("unmatched_rows").update({
      resolved_at: new Date().toISOString(),
      resolved_contact_id: sup.contact_id,
      resolved_by: "superseded",
    }).eq("row_id", sup.row_id).is("resolved_at", null);
    if (error) throw new ImportError(`Clearing a superseded parked row failed: ${error.message}`);
  }

  /**
   * The other half of the same problem: a row that parked before and parks
   * again.
   *
   * The loop above retires a parked row that this import has just made
   * countable. It cannot see the row that still doesn't match — that one is
   * inserted fresh above, and the copy from the previous upload of the same
   * file stays in the queue beside it. Re-uploading sales once took the queue
   * to 17 rows holding SGD 8,649 when the file described 9 rows holding 4,473:
   * the same eight people counted twice, and "understated by exactly this
   * queue, never overstated" quietly became false in the direction it promises
   * is impossible.
   *
   * A re-import is the authority for the period it covers, so its predecessors
   * for that period are spent. Containment, not overlap, is the test: importing
   * June sales must not retire May's parked rows, because the June file says
   * nothing about them. A narrower re-import leaves the wider batch alone for
   * the same reason — keeping a row a human can dismiss beats dropping one
   * silently.
   *
   * resolved_by records 'restated' rather than 'superseded' so the two cases
   * stay distinguishable in the audit trail: one was answered, this one was
   * replaced.
   */
  // Rows this import saw again and still cannot match move onto this batch
  // first, so the sweep below retires only what is genuinely spent.
  if (plan.ops.adoptedParked.length) {
    const { error } = await db
      .from("unmatched_rows")
      .update({ import_batch_id: batchId })
      .in("row_id", plan.ops.adoptedParked)
      .is("resolved_at", null);
    if (error) throw new ImportError(`Re-asserting a parked row failed: ${error.message}`);
  }

  if (plan.coverage.start && plan.coverage.end) {
    const { data: prior, error: e } = await db
      .from("import_batches")
      .select("batch_id, coverage_start, coverage_end")
      .eq("client_id", plan.clientId)
      .eq("source", plan.source)
      .eq("status", "committed")
      .neq("batch_id", batchId);
    if (e) throw new ImportError(`Reading earlier batches failed: ${e.message}`);

    const spent = (prior ?? [])
      .filter(
        (b) =>
          b.coverage_start &&
          b.coverage_end &&
          b.coverage_start >= plan.coverage.start! &&
          b.coverage_end <= plan.coverage.end!,
      )
      .map((b) => b.batch_id);

    if (spent.length) {
      const { error: e2 } = await db
        .from("unmatched_rows")
        .update({ resolved_at: new Date().toISOString(), resolved_by: "restated" })
        .in("import_batch_id", spent)
        .is("resolved_at", null);
      if (e2) throw new ImportError(`Retiring replaced parked rows failed: ${e2.message}`);
    }
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
