import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/supabase/admin";
import { parseCsv, toNumber, toDate, toTimestamp, localDay, type Row } from "./csv";
import { SOURCES, mapColumns, stageMetricOf, stageSpec, type ImportSourceKey, type SourceKey, type SourceSpec } from "./sources";
import { buildIndex, matchRow, normEmail, normPhone, type KnownContact, type ParkReason } from "./identity";
import { attributeLead, closeRoundFor, resolveRoundRef, resolveProduct, roundFromCampaign, type Round, type AdSetRun } from "./attribute";
import { parseClarityScroll, ClarityError, sessionsFrom } from "./clarity";

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
  source: ImportSourceKey;
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
    /**
     * Rows counted as a headcount, with nobody attached.
     *
     * Kept apart from every other number on this screen because it is the one
     * that has to stay arguable. These are people the app is sure ARRIVED and
     * cannot NAME — countable in a round total and in a source total, and
     * useless for anything that needs a person: they can never close a sale,
     * never carry revenue, never leave the anonymous column.
     */
    unidentified: number;
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
    /**
     * A landing-page scroll curve and the round it describes.
     *
     * Its own slot rather than a row in `events` or `ads`: it has no person and
     * no money on it, and its denominator is sessions — see 0032. One per
     * import, because one Clarity export is one measurement.
     */
    scroll: ScrollWrite | null;
  };
};

export type ScrollWrite = {
  run: Record<string, unknown>;
  points: Array<{ depth_pct: number; visitors: number; drop_off_pct: number | null }>;
  /** A run already covering this page/device/window, which this one replaces. */
  replaces: string | null;
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

/**
 * The dedupe handle for a row that has a name and no identity.
 *
 * Deliberately NOT an identity. It is never compared against a contact, never
 * used to attach a purchase, and never leaves this file — its only job is to
 * make a headcount idempotent, so re-dropping the same roster counts the same
 * people once rather than twice.
 *
 * Two people genuinely called "Katherine" in one round therefore collapse to
 * one. That under-counts by one and cannot over-count, which is the direction
 * every other rule here errs in. Measured on Shely's nine rosters: 188
 * name-only rows, zero collisions.
 */
/**
 * AN AUDIENCE OR CREATIVE NAME, WITH META'S DUPLICATE SUFFIX TAKEN OFF.
 *
 * Duplicating an ad set in Ads Manager names the copy "X - Copy". The name is
 * usually corrected there and the tracking link is not, so GoHighLevel keeps
 * writing the old one — and the audience arrives under a name no ads row has.
 *
 * The cost is not cosmetic. An asset is bridged to spend by matching
 * events.ad_set to ads_performance.ad_set, so a lead under "X - Copy" lands in
 * a column of its own with a dash for every unit cost, while the real audience
 * shows the spend that produced it and not the leads. Both figures are wrong
 * and neither looks it. On Shely's data: 23 leads and 78 creative rows split
 * away this way, and the September export has 105 more.
 *
 * Applied to leads AND to ads, so the two can never disagree about a name.
 * Every suffix seen so far is stripped — hyphen, en dash and em dash, any case,
 * a trailing copy number, and repeats — but nothing else is touched: a name is
 * otherwise written exactly as the export gave it.
 */
const COPY_SUFFIX = /(?:\s*[-–—]\s*copy(?:\s*\d+)?)+\s*$/i;
/**
 * A dash that has been through the wrong decoder on its way here.
 *
 * "â€“" is a UTF-8 en dash read as Latin-1, and it arrives that way from
 * spreadsheets that were saved by one tool and exported by another. It has to
 * be repaired BEFORE the suffix is matched: the September export named its
 * creatives "Static_ContentAtScale_StructuredText â€“ Copy", the dash class in
 * COPY_SUFFIX did not include that sequence, and 103 leads kept a suffix the
 * strip was written to remove. A name is also simply wrong when displayed like
 * that, so this is worth doing for its own sake.
 */
const MOJIBAKE: Array<[RegExp, string]> = [
  [/â€“/g, "–"], [/â€”/g, "—"], [/â€™/g, "’"], [/â€˜/g, "‘"],
  [/â€œ/g, "“"], [/â€\u009d/g, "”"], [/Â /g, " "], [/\uFEFF/g, ""],
];
const normAsset = (raw: string | null): string | null => {
  let s = String(raw ?? "").trim();
  if (!s) return raw === null || raw === undefined ? null : raw;
  for (const [re, to] of MOJIBAKE) s = s.replace(re, to);
  const cleaned = s.replace(COPY_SUFFIX, "").trim();
  return cleaned || s;
};

const anonKey = (rawName: string | null): string | null => {
  const name = String(rawName ?? "").toLowerCase()
    .replace(/\(.*?\)/g, " ")          // "Jay (Jael Tan)" is one person
    .replace(/[^a-z0-9À-￿ ]/g, " ")
    .split(/\s+/).filter(Boolean).join(" ");
  return name ? `anon:${name}` : null;
};

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

/**
 * Rounds, each carrying every class it runs.
 *
 * Two reads rather than a join: PostgREST's embedding would need a foreign key
 * the anon role can see, and this is two small tables. Sessions are read from
 * the table, not v_round_sessions, because an import is not looking at a
 * filtered screen — it has to see every round the file might name.
 */
async function loadRounds(db: SupabaseClient, clientId: string): Promise<Round[]> {
  const [roundRows, sessionRows] = await Promise.all([
    fetchAll<Omit<Round, "session_dates"> & { session_date: string | null }>(
      db, "rounds", "round_id, client_id, start_date, end_date, session_date",
      (q) => q.eq("client_id", clientId)),
    fetchAll<{ round_id: string; session_date: string }>(
      db, "round_sessions", "round_id, session_date"),
  ]);
  const sessionsByRound = new Map<string, string[]>();
  for (const s of sessionRows) {
    const list = sessionsByRound.get(s.round_id) ?? [];
    list.push(s.session_date);
    sessionsByRound.set(s.round_id, list);
  }
  const rounds: Round[] = roundRows.map((r) => ({
    round_id: r.round_id, client_id: r.client_id,
    start_date: r.start_date, end_date: r.end_date,
    // fall back to the round's own column for a database that hasn't run 0025
    session_dates: sessionsByRound.get(r.round_id) ?? (r.session_date ? [r.session_date] : []),
  }));
  if (!rounds.length) throw new ImportError("This client has no rounds yet — create a round before importing.");
  return rounds;
}

/**
 * Which round a capture window describes: the one it overlaps most.
 *
 * Not containment. Clarity's window is whatever was typed into its date picker
 * and a round's window is five days on a wall calendar; requiring one to sit
 * inside the other would refuse the ordinary case where someone exported "last
 * 7 days" over a 5-day round. Most-overlap picks the round the export is mostly
 * about, and the number of days that actually overlap is reported so a 1-day
 * sliver never passes as a match in silence.
 */
export function roundForWindow(
  from: string | null, to: string | null, rounds: Round[],
): { round: Round; days: number; span: number } | null {
  if (!from || !to) return null;
  const day = 86_400_000;
  const days = (a: string, b: string) =>
    Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / day) + 1;
  const span = days(from, to);

  let best: { round: Round; days: number; span: number } | null = null;
  for (const r of rounds) {
    const s = dayOf(r.start_date)!;
    const e = dayOf(r.end_date)!;
    const lo = from > s ? from : s;
    const hi = to < e ? to : e;
    if (lo > hi) continue;
    const overlap = days(lo, hi);
    if (!best || overlap > best.days) best = { round: r, days: overlap, span };
  }
  return best;
}

/**
 * A Microsoft Clarity scroll export.
 *
 * Short because there is no person to match and no money to attribute: the
 * whole job is read the file, find the round it describes, and notice when it
 * replaces one already stored. What it does share with the other four is the
 * shape — it stages a plan, writes nothing, and the diff shown is the diff that
 * gets applied.
 */
async function planScroll(
  db: SupabaseClient,
  { clientId, fileName, text }: { clientId: string; fileName: string; text: string },
): Promise<Plan> {
  let read;
  try {
    read = parseClarityScroll(text, fileName);
  } catch (err) {
    if (err instanceof ClarityError) throw new ImportError(err.message, err.detail);
    throw err;
  }

  const rounds = await loadRounds(db, clientId);
  const hit = roundForWindow(read.captured_from, read.captured_to, rounds);

  if (!hit) {
    throw new ImportError(
      read.captured_from
        ? `No round overlaps ${read.captured_from} → ${read.captured_to}.`
        : "That export has no readable date range, so there is no way to tell which round it describes.",
      [
        `Rounds on record: ${rounds.map((r) => `${r.round_id} (${dayOf(r.start_date)}→${dayOf(r.end_date)})`).join(" · ")}`,
        "Re-export from Clarity with the round's own dates in the picker.",
      ],
    );
  }

  const warnings: string[] = [];
  const { round, days, span } = hit;

  // A window that mostly misses the round still gets imported — it is a real
  // measurement of a real page — but it is not allowed to look like a clean fit.
  if (days < span) {
    warnings.push(
      `The export covers ${span} day${span === 1 ? "" : "s"} and only ${days} of them fall inside ` +
      `${round.round_id}. The curve is being filed against that round anyway; the days outside it ` +
      `describe traffic no round here accounts for.`,
    );
  }
  if (read.page_views !== null && read.page_views !== read.sessions) {
    warnings.push(
      `Clarity reports ${read.page_views} page views and a curve built on ${read.sessions} sessions. ` +
      `The ${read.sessions} is used — a view that never fired a scroll event is not on the curve — ` +
      `so every percentage here is out of ${read.sessions}.`,
    );
  }
  const { spread } = sessionsFrom(read.points);
  if (spread > 1) {
    warnings.push(
      `The rows disagree about how many sessions there were, by up to ${spread}. ` +
      `The most common answer (${read.sessions}) is used.`,
    );
  }
  if (read.device === "all") {
    warnings.push(
      `No device is named in "${fileName}", so this is recorded as covering all devices. ` +
      `Clarity puts the device filter in the file name only — if this was a mobile-only export, ` +
      `rename the file so it says so and import it again.`,
    );
  }

  /**
   * A curve already stored for this page, device and window.
   *
   * Re-exporting the same days is the normal way to pick up late data, so it
   * replaces rather than parks or duplicates — two copies of one measurement
   * would read as twice the traffic. The old run's id is carried so commit can
   * remove it in the same pass, and the diff calls it a change, not an insert.
   */
  const { data: prior } = await db
    .from("scroll_runs")
    .select("run_id")
    .eq("client_id", clientId)
    .eq("round_id", round.round_id)
    .eq("device", read.device)
    .eq("captured_from", read.captured_from!)
    .eq("captured_to", read.captured_to!)
    .maybeSingle();

  const runId = uuid();
  return {
    source: "scroll", clientId, fileName,
    columnMap: {}, unusedColumns: [],
    rowCount: read.points.length,
    coverage: { start: read.captured_from, end: read.captured_to },
    counts: { matchedExact: 0, matchedAuto: 0, newContacts: 0, parked: 0, duplicates: 0, unidentified: 0 },
    attribution: { utm: 0, dateWindow: 0, none: 0 },
    diff: {
      newRows: prior ? 0 : read.points.length,
      changedRows: prior ? read.points.length : 0,
      restatements: prior
        ? [`would replace the scroll curve already stored for ${round.round_id} (${read.device}) over these dates`]
        : [],
    },
    warnings: [...new Set(warnings)],
    prerequisite: null,
    ops: {
      contacts: [], events: [], ads: [], unmatched: [], refundUpdates: [],
      supersededParked: [], adoptedParked: [],
      scroll: {
        run: {
          run_id: runId,
          client_id: clientId,
          round_id: round.round_id,
          page_label: read.page_label,
          url_pattern: read.url_pattern,
          device: read.device,
          page_views: read.page_views,
          sessions: read.sessions,
          captured_from: read.captured_from,
          captured_to: read.captured_to,
          source_file: fileName,
        },
        points: read.points.map((p) => ({
          depth_pct: Math.round(p.depth),
          visitors: p.visitors,
          drop_off_pct: p.drop_off_pct,
        })),
        replaces: prior?.run_id ?? null,
      },
    },
  };
}

export async function planImport(
  db: SupabaseClient,
  { source, clientId, fileName, text, asContactId }: {
    source: ImportSourceKey; clientId: string; fileName: string; text: string;
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
  /**
   * The spec is looked up, not indexed.
   *
   * A built-in source is a row of SOURCES. A `stage:` source is a metric
   * somebody declared in journey_metrics, and its spec is built from that row —
   * so importing a stage nobody declared fails here, by name, rather than
   * writing events carrying an event_type the database will refuse.
   */
  const declaredMetric = stageMetricOf(source);
  let spec: SourceSpec | undefined = declaredMetric ? undefined : SOURCES[source as SourceKey];
  if (declaredMetric) {
    const { data: jm, error: jmError } = await db
      .from("journey_metrics")
      .select("metric, label, event_type, is_core")
      .eq("metric", declaredMetric)
      .maybeSingle();
    if (jmError) throw new ImportError(`Could not read journey_metrics: ${jmError.message}`);
    if (!jm) throw new ImportError(`No metric "${declaredMetric}" is declared. Add it to journey_metrics before importing one.`);
    if (jm.is_core) throw new ImportError(`"${declaredMetric}" is a core metric with its own import — use that source rather than stage:${declaredMetric}.`);
    if (!jm.event_type) throw new ImportError(`"${declaredMetric}" is not counted from events, so there is no file to import for it.`);
    spec = stageSpec(jm.metric as string, jm.label as string, jm.event_type as string);
  }
  if (!spec) throw new ImportError(`Unknown source "${source}".`);

  /**
   * Branched before the CSV is read, not inside the loop below.
   *
   * A Clarity export would parse without complaint — it is valid CSV — and
   * every line of it would be wrong: line 1 is "Project name","…", so the
   * header would be a page title and the rows would be metadata. Nothing
   * downstream would notice. The shape has to be decided before the file is
   * read as a table, which is the only reason this sits here rather than beside
   * the other four.
   */
  if (source === "scroll") return planScroll(db, { clientId, fileName, text });

  // ── 1. IMPORT ────────────────────────────────────────────────────────────
  const { headers, rows } = parseCsv(text);
  if (!rows.length) throw new ImportError("That file has no data rows.");

  const { data: remembered } = await db
    .from("v_column_map").select("column_map").eq("client_id", clientId).eq("source", source).maybeSingle();

  const { map, missing, broken, unused } = mapColumns(spec, headers, remembered?.column_map ?? null);

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
  const rounds = await loadRounds(db, clientId);

  const roundIds = rounds.map((r) => r.round_id);

  const plan: Plan = {
    source, clientId, fileName, columnMap: map, unusedColumns: unused,
    rowCount: rows.length,
    coverage: { start: null, end: null },
    counts: { matchedExact: 0, matchedAuto: 0, newContacts: 0, parked: 0, duplicates: 0, unidentified: 0 },
    attribution: { utm: 0, dateWindow: 0, none: 0 },
    diff: { newRows: 0, changedRows: 0, restatements: [] },
    warnings,
    prerequisite: null,
    ops: { contacts: [], events: [], ads: [], unmatched: [], refundUpdates: [], supersededParked: [], adoptedParked: [], scroll: null },
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

      const adSet = normAsset(val(r, "ad_set"));
      const ad = normAsset(val(r, "ad"));
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
    anon_key: string | null;
  }>(db, "events",
    "event_id, contact_id, round_id, event_type, event_date, product, amount, refund_amount, lead_round_id, source, anon_key",
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
  /** Every opt-in this person has, oldest first. */
  const leadsByContact = new Map<string, { round: string; date: string; source: string | null }[]>();
  const leadSourceByContact = new Map<string, string>();
  for (const e of events) {
    if (!e.contact_id) continue;
    if (e.event_type === "attendance") {
      const list = attendancesByContact.get(e.contact_id) ?? [];
      list.push({ round_id: e.round_id, event_date: e.event_date });
      attendancesByContact.set(e.contact_id, list);
    }
    if (e.event_type === "lead" && e.lead_round_id) {
      const list = leadsByContact.get(e.contact_id) ?? [];
      list.push({ round: e.lead_round_id, date: e.event_date, source: e.source ?? null });
      leadsByContact.set(e.contact_id, list);
      if (e.source) leadSourceByContact.set(e.contact_id, e.source);
    }
  }
  for (const list of leadsByContact.values()) {
    list.sort((a, b) => (sgDayOf(a.date) ?? "").localeCompare(sgDayOf(b.date) ?? ""));
  }

  /**
   * THE ROUND THAT ACQUIRED THIS PERSON BY THE TIME OF `when`.
   *
   * Two rules, and the app used to have neither.
   *
   * EARLIEST, not latest. "Whose spend produced this?" is answered by the first
   * opt-in, not the most recent one. Somebody who registered in May and again in
   * June was acquired in May; June inherited them. That is exactly what the
   * Previous Paid Ads bucket exists to express, and taking the later lead would
   * erase the distinction it was built to draw.
   *
   * NOTHING, if every opt-in came afterwards. Five buyers in the May–August load
   * bought at one class and then registered for the NEXT round days later, and
   * their money followed the opt-in forward — $2,094 filed under rounds that had
   * not yet met them, and $397 of August revenue sitting in September. A lead
   * dated after the sale did not produce the sale. Returning null sends the row
   * to the round the money actually arrived in (0052) and keeps it out of ROAS,
   * which is the honest reading of a purchase nothing acquired.
   */
  const leadAsOf = (contactId: string, when: string | null) => {
    const first = leadsByContact.get(contactId)?.[0];
    if (!first) return null;
    if (when && sgDayOf(first.date)! > sgDayOf(when)!) return null;
    return first;
  };
  const leadRoundAsOf = (contactId: string, when: string | null): string | null =>
    leadAsOf(contactId, when)?.round ?? null;

  /**
   * The source travels with the round that acquired them, not with whichever
   * opt-in happened to be read last — a test caught these two disagreeing, and
   * a row saying "acquired by May, source June" is not a fact about anybody.
   *
   * A later opt-in still NAMES someone when nothing acquired them in time. It
   * just cannot claim their purchase, and it must never claim it for the ads:
   * Paid Ads is dropped rather than inherited, because a sale made before the
   * opt-in was not bought by the advertising that followed it.
   */
  const sourceFor = (contactId: string, when: string | null, fileSource: string | null) => {
    const acquiring = leadAsOf(contactId, when);
    if (acquiring) return acquiring.source;
    if (fileSource) return fileSource;
    const known = leadSourceByContact.get(contactId) ?? null;
    return known === "Paid Ads" ? null : known;
  };

  // dedupe key per event type
  const eventKey = (t: string, contactId: string, roundId: string | null, date: string, product?: string | null) =>
    `${t}|${contactId}|${roundId ?? ""}|${sgDayOf(date)}|${product ?? ""}`;
  /**
   * An anonymous row has no contact, so `contact_id ?? ""` collapses every head
   * in a room to one string that matches nothing the writer produces — and the
   * re-import writes all of them again. 578 attendances became 790 that way.
   * anon_key is the handle they were written with; 0054 stores it so this set
   * can be rebuilt from what is already there.
   */
  const seenEvents = new Set(
    events.map((e) =>
      eventKey(e.event_type, e.anon_key ?? e.contact_id ?? "", e.round_id, e.event_date, e.product),
    ),
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
    /**
     * WHICH FILES MAY INTRODUCE A PERSON: the ones that carry a first contact.
     *
     * Leads, obviously. Sales for a reason the queue made unarguable — a buyer
     * who never opted in parked as `bought_without_lead`, and the only control
     * the screen offered was Assign, which needs an EXISTING contact to assign
     * to. There isn't one. So the single working button was Dismiss, and
     * Dismiss discards the money. A queue that can only be emptied by losing
     * revenue is not review, it is attrition.
     *
     * Attendance stays out. Someone in a webinar room we cannot name is a
     * headcount, not a person, and 0051 already counts them without inventing
     * one. A payment is different: it names a buyer and hands over money.
     *
     * A row with neither address nor phone still parks — matchRow returns
     * name_only before it reads this flag. Nothing is invented from nothing.
     */
    const mayIntroduce = source === "leads" || source === "sales";
    const outcome = asContactId
      ? ({ kind: "exact", contactId: asContactId } as const)
      : matchRow(index, val(r, "email"), val(r, "phone"), mayIntroduce);

    let contactId: string | null = null;
    if (outcome.kind === "exact") { contactId = outcome.contactId; plan.counts.matchedExact++; }
    else if (outcome.kind === "auto") { contactId = outcome.contactId; plan.counts.matchedAuto++; }
    else if (outcome.kind === "new") { contactId = addContact(email, phone); }

    // ── LEADS ──────────────────────────────────────────────────────────────
    if (source === "leads") {
      const when = toTimestamp(val(r, "event_date"));
      if (!contactId) {
        /**
         * WE DON'T KNOW WHO IS NOT THE SAME AS WE DON'T KNOW IF.
         *
         * A row with a name, a date and a source but no address says three
         * things the app can check and one it cannot. Parking it threw away
         * all four, so a client whose organic list never fills in a form read
         * as having no organic leads at all — 206 of Shely's 1,467, and the
         * source column said "Organic" on every one of them.
         *
         * Counted here as a headcount and nothing more. It has no contact, so
         * it can never carry revenue, close a sale, or be matched to a later
         * purchase, and it never leaves the anonymous column. What it can do
         * is appear in its round's total and its source's total, which is
         * exactly what the export is evidence of.
         *
         * Still parked when the row cannot be placed at all: no name to dedupe
         * a re-import against, no date, or no round. Counting one of those
         * would be inventing the arrival, not just the identity.
         */
        /**
         * Only a row carrying NO address at all. `name_only` is identity.ts's
         * own word for that and nothing else reaches it.
         *
         * A row that has an email we simply don't hold yet is a different
         * problem with a different fix — somebody can type the answer — so it
         * keeps its place in the queue. Counting it here would take a
         * resolvable row and quietly make it unresolvable.
         */
        const nameOnly = outcome.kind === "park" && outcome.reason === "name_only";
        const anon = nameOnly ? anonKey(val(r, "name")) : null;
        if (!anon || !when) {
          park(outcome.kind === "park" ? outcome.reason : "name_only", r, null, null, "none");
          continue;
        }
        const anonSet = normAsset(val(r, "ad_set"));
        const anonAttr = attributeLead(when, anonSet, rounds, adRuns);
        if (!anonAttr.roundId) {
          park("no_matching_round", r, null, "no round covers this opt-in date", "none");
          continue;
        }
        if (anonAttr.method === "utm") plan.attribution.utm++;
        else if (anonAttr.method === "date_window") plan.attribution.dateWindow++;
        else plan.attribution.none++;
        const key = eventKey("lead", anon, anonAttr.roundId, when);
        if (seenEvents.has(key)) { plan.counts.duplicates++; continue; }
        seenEvents.add(key);
        track(sgDayOf(when));
        plan.ops.events.push({
          event_id: uuid(), contact_id: null, round_id: anonAttr.roundId, event_type: "lead", anon_key: anon,
          event_date: when, lead_round_id: anonAttr.roundId, attribution_method: anonAttr.method,
          utm_campaign: val(r, "utm_campaign") || null,
          ad_set: anonSet, ad: normAsset(val(r, "ad")),
          // Never "Paid Ads" by inference. A row the ads could have produced
          // would also have carried an address; this one didn't, so the file's
          // own answer stands or it is organic.
          source: val(r, "source") || "Organic",
          match_status: "unidentified",
        });
        plan.counts.unidentified++;
        plan.diff.newRows++;
        continue;
      }
      if (!when) { park("incomplete_row", r, null, "no usable opt-in date", "none"); continue; }
      track(sgDayOf(when));

      // The audience is what bridges a person to spend, so it is what decides
      // the round. utm_campaign names the round's campaign, not an ad set.
      const adSet = normAsset(val(r, "ad_set"));
      const adName = normAsset(val(r, "ad"));
      const utm = val(r, "utm_campaign");
      /**
       * A named round is not a hint, it is the file saying which of its lists
       * this row was on, and nothing outranks it.
       *
       * The UTM did, briefly, on the reasoning that a click on a round's ad is
       * evidence about that ad. It is — about the AD, which this row still
       * records in ad_set and ad, and which every audience and creative figure
       * is built from. It is not evidence about WHICH CLASS THEY SIGNED UP FOR.
       * Somebody can click June's ad and register for July's webinar, and 90 of
       * Shely's leads did exactly that: the UTM moved them to the round whose
       * ad they clicked and off the list they were actually on.
       *
       * A name that matches no round is ignored rather than trusted, so a typo
       * cannot invent an attribution.
       */
      const declared = val(r, "round_id");
      const stated = declared ? resolveRoundRef(declared, rounds) : null;
      const guess = attributeLead(when, adSet, rounds, adRuns);
      const roundId = stated ?? guess.roundId;
      const method = stated ? "declared" : guess.method;
      if (declared && !stated) {
        warnings.push(`Round "${declared}" isn't a round for this client — that row was attributed the usual way.`);
      }
      if (method === "utm") plan.attribution.utm++;
      else if (method === "date_window") plan.attribution.dateWindow++;
      else if (method !== "declared") plan.attribution.none++;

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

    /**
     * ── A PERSON REACHED A STAGE ───────────────────────────────────────────
     *
     * Attendance was the only source that ever took this shape, so the branch
     * was written as `source === "attendance"`. It is the shape of every
     * per-person stage — somebody, a round, and when — so it now branches on
     * the spec declaring an event type, and attendance is simply the first
     * metric that does. A declared stage runs this exact path, which means the
     * generic route is the one production has been exercising all along.
     */
    if (spec.eventType) {
      const eventType = spec.eventType;
      const ref = val(r, "round_id");
      const roundId = ref ? resolveRoundRef(ref, rounds) : null;
      if (!contactId) {
        /**
         * The same rule as leads, and the case that motivated it.
         *
         * A webinar roster is the one export where the people the app cannot
         * name are not an accident: a third of Shely's room joins on a link
         * somebody forwarded, so they never opted in and never gave an
         * address. Parking them read as a show rate of 32% against a real one
         * near 60%, and it read that way silently.
         *
         * A row naming a round is evidence somebody was in that room. That is
         * countable. Who they were is not, and nothing downstream is allowed
         * to pretend otherwise — the event carries no contact, so it cannot
         * reach close_round_id, cannot take revenue, and cannot be resolved
         * later into a person.
         */
        // See the leads branch: no address at all, or it stays in the queue.
        const nameOnly = outcome.kind === "park" && outcome.reason === "name_only";
        const anon = nameOnly ? anonKey(val(r, "name")) : null;
        if (!anon || !roundId) {
          const o = outcome as Extract<typeof outcome, { kind: "park" }>;
          if (!roundId) park("no_matching_round", r, null, `no round matches session "${ref ?? ""}"`, "none");
          else park(o.reason, r, o.bestGuess, o.guessMethod, o.confidence);
          continue;
        }
        const anonRound = rounds.find((x) => x.round_id === roundId)!;
        const anonLast = anonRound.session_dates.length
          ? anonRound.session_dates.slice().sort().slice(-1)[0]
          : null;
        const anonWhen = toTimestamp(val(r, "event_date"))
          ?? new Date(`${dayOf(anonLast ?? anonRound.end_date)}T20:00:00+08:00`).toISOString();
        const key = eventKey(eventType, anon, roundId, anonWhen);
        if (seenEvents.has(key)) { plan.counts.duplicates++; continue; }
        seenEvents.add(key);
        track(sgDayOf(anonWhen));
        plan.ops.events.push({
          event_id: uuid(), contact_id: null, round_id: roundId, event_type: eventType,
          event_date: anonWhen, anon_key: anon,
          // No lead behind them, so no acquisition round to inherit. Left null
          // rather than filled with roundId: this round's class is where they
          // were, not where they came from, and the two must not be conflated.
          lead_round_id: null,
          source: val(r, "source") || "Organic",
          minutes_watched: Math.round(toNumber(val(r, "minutes_watched")) ?? 0) || null,
          match_status: "unidentified",
        });
        plan.counts.unidentified++;
        plan.diff.newRows++;
        continue;
      }
      if (!roundId) { park("no_matching_round", r, null, `no round matches session "${ref ?? ""}"`, "none"); continue; }

      const round = rounds.find((x) => x.round_id === roundId)!;
      // no date on the row: fall back to the round's LAST class, then its end.
      // The last rather than the first, because a row with no date is most
      // likely the final session's export.
      const lastClass = round.session_dates.length
        ? round.session_dates.slice().sort().slice(-1)[0]
        : null;
      const when = toTimestamp(val(r, "event_date"))
        ?? new Date(`${dayOf(lastClass ?? round.end_date)}T20:00:00+08:00`).toISOString();
      track(sgDayOf(when));

      const key = eventKey(eventType, contactId, roundId, when);
      if (seenEvents.has(key)) { plan.counts.duplicates++; continue; }
      seenEvents.add(key);

      plan.ops.events.push({
        event_id: uuid(), contact_id: contactId, round_id: roundId, event_type: eventType,
        event_date: when,
        // Same rule as sales: the opt-in that came first, and only if it came
        // before the room did. Someone who attends and registers for the next
        // round afterwards was not acquired by the round they have not met.
        lead_round_id: leadRoundAsOf(contactId, when),
        source: sourceFor(contactId, when, val(r, "source")),
        minutes_watched: Math.round(toNumber(val(r, "minutes_watched")) ?? 0) || null,
        match_status: outcome.kind === "auto" ? "auto_resolved" : "matched",
      });
      supersede(r, contactId);
      /**
       * Only a class closes a sale.
       *
       * close_round_id says which class a purchase closed at, and 0020 and the
       * sale attribution both rest on it. A declared stage is not a class — an
       * appointment is not the room somebody bought in — so it must not move
       * that credit. This is the one thing attendance still does that a generic
       * stage does not, and it is gated on the event type rather than on the
       * source name so it stays true if attendance is ever renamed.
       */
      if (eventType === "attendance") {
        const list = attendancesByContact.get(contactId) ?? [];
        list.push({ round_id: roundId, event_date: when });
        attendancesByContact.set(contactId, list);
      }
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
      const leadRound = leadRoundAsOf(contactId, when);
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
        // The acquiring lead wins wherever there is one — a payments export does
        // not get to restate how somebody was acquired. The column answers only
        // where no lead can. See sourceFor above and the note in sources.ts.
        source: sourceFor(contactId, when, val(r, "source")),
        is_lead: Boolean(leadRound),
        match_status: outcome.kind === "auto" ? "auto_resolved" : "matched",
      });
      supersede(r, contactId);
      plan.diff.newRows++;
      if (!leadRound) {
        // Says which round, because "counted in revenue" was the half of this
        // sentence that used to be false — every per-round view dropped the
        // row. 0052 made it true; naming the round is how the screen proves it.
        warnings.push(
          `At least one sale has no lead behind it — counted in ${purchaseRound} revenue, excluded from ROAS.`,
        );
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
  /**
   * The scroll curve, replaced whole.
   *
   * Delete-then-insert rather than upsert, because the readings are the unit
   * that has to stay consistent: a re-export whose curve stops at 90% would
   * otherwise leave the old 95% and 100% rows behind, and the curve would
   * describe a measurement nobody ever took. The depths go with the run through
   * `on delete cascade`, so removing the run is enough.
   */
  if (plan.ops.scroll) {
    const s = plan.ops.scroll;
    if (s.replaces) {
      const { error } = await db.from("scroll_runs").delete().eq("run_id", s.replaces);
      if (error) throw new ImportError(`Replacing the earlier scroll curve failed: ${error.message}`);
    }
    const { error: e1 } = await db.from("scroll_runs").insert({ ...s.run, import_batch_id: batchId });
    if (e1) throw new ImportError(`Writing the scroll run failed: ${e1.message}`);

    const { error: e2 } = await db.from("scroll_depths")
      .insert(s.points.map((p) => ({ ...p, run_id: s.run.run_id })));
    if (e2) throw new ImportError(`Writing the scroll curve failed: ${e2.message}`);
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
