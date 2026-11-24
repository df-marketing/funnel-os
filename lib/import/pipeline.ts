import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAll } from "@/lib/supabase/admin";
import { parseCsv, toNumber, toDate, toTimestamp, toLeadTimestamp, localDay, inferDateOrder, type Row, type DateOrder } from "./csv";
import { SOURCES, mapColumns, columnDiagnostics, stageMetricOf, stageSpec, type ImportSourceKey, type SourceKey, type SourceSpec } from "./sources";
import { buildIndex, matchRow, normEmail, normPhone, type KnownContact, type ParkReason } from "./identity";
import { declaredLeadRound, leadAttributor, leadDateInRound, closeRoundFor, resolveRoundRef, resolveProduct, roundFromCampaign, roundOwningCampaign, type Round, type AdSetRun } from "./attribute";
import { normalizeProfileDate, type MappingProfile, type ProfileDateRule } from "./mapping-profile";
import { parseClarityScroll, ClarityError, sessionsFrom, pageKeyOf } from "./clarity";

/**
 * The pass, as the workflow doc specifies it:
 *
 *   1 IMPORT     parse, map columns (remembered per source, breaks loudly)
 *   2 MATCH      exact / auto-resolved / parked
 *   3 ATTRIBUTE  lead_round_id + how it was decided
 *   4 DIFF       new rows, changed rows, restatement warnings
 *   5 COMMIT     written only on approval
 *
 * Steps 1–4 run in `planImport` and write nothing. Step 5 is `commitPlan`.
 * The plan is persisted on the batch so the diff you approve is the diff that
 * gets applied — not a re-parse that might differ.
 */

export type LeadDestination = { roundId: string; label: string; count: number; declaredOutsideWindow: number };
const LEAD_ROUND_GUARD_VERSION = 1;

export type Plan = {
  source: ImportSourceKey;
  clientId: string;
  fileName: string;
  columnMap: Record<string, string>;
  review?: {
    worksheet?: string;
    stageSlug?: string | null;
    binding?: string;
    dateOrder?: ProfileDateRule;
    profile?: { id: string; revision: number; name: string };
  };
  leadRoundGuard?: { version: typeof LEAD_ROUND_GUARD_VERSION; destinations: LeadDestination[] };
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
     * Answers for a lead that is ALREADY here.
     *
     * The form questions arrive on a contacts export months after the lead
     * itself did, so almost every row naming an answer is a row this app
     * already has. Skipping it as a duplicate — which is right for the event —
     * threw the answer away with it: on the first real export, 1,407 of 1,469
     * rows were skipped and the answers reached 47 people.
     *
     * A duplicate lead is still not a new lead. It is the same lead, now
     * carrying something it did not carry before.
     */
    answerUpdates: Array<{ event_id: string; answers: Record<string, string> }>;
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
     * They keep their place in the original queue. Kept in the preview
     * payload for the reviewed-mapping restriction, not rewritten on commit.
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
// UUIDv8 for new upload rows only. Same client + persisted business identity
// trips the primary key even if two requests both planned before either wrote.
// Do not use this for opaque person/name identities.
function uploadedAdId(clientId: string, key: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["funnel-os:ads-upload:v1", clientId, key])).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const adsMeasureFields = ["spend", "impressions", "reach", "clicks"] as const;
type AdsIdentity = {round_id: string; date: string; campaign: string | null; ad_set: string | null; ad: string | null; channel?: string | null; ad_id?: string | null};
type AdsComparable = AdsIdentity & Partial<Record<typeof adsMeasureFields[number], number | string | null>> & {
  measures?: Record<string, number | string | null> | null;
};
function adsKey(r: AdsIdentity): string {
  return JSON.stringify([r.round_id, r.date, r.channel ?? ASSUMED_CHANNEL, r.campaign || null, r.ad_set || null, r.ad || null]);
}
function comparableMetric(field: string, value: string | number): number {
  const n = Number(value);
  return field === "spend" || field === "amount" ? Math.round(n * 100) : n;
}
function adSeriesKey(r: AdsIdentity): string {
  return JSON.stringify([r.round_id, r.channel ?? ASSUMED_CHANNEL, r.campaign || null, r.ad_set || null, r.ad || null]);
}
function changedAdMeasurement(old: AdsComparable, current: AdsComparable): boolean {
  if (old.ad_id && current.ad_id && old.ad_id !== current.ad_id) return true;
  return adsMeasureFields.some((k) => current[k] != null &&
    (old[k] == null || comparableMetric(k, old[k]!) !== comparableMetric(k, current[k]!))) ||
    Object.entries(current.measures ?? {}).some(([k, v]) => v != null &&
      (old.measures?.[k] == null || Number(old.measures[k]) !== Number(v)));
}

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

/**
 * WHICH COUNTRY'S CAMPAIGN BROUGHT SOMEBODY IN.
 *
 * Every campaign in this account is prefixed DF_SG_ or DF_MY_, and a round can
 * run both at once — 0926-01 did, which is why the country cannot live on the
 * round. Read from the lead's own utm_campaign; anything that is not that shape
 * is not a country and is not guessed into one.
 */
const countryOf = (campaign: string | null): string | null => {
  const m = /^DF_([A-Z]{2})_/.exec(String(campaign ?? "").trim().toUpperCase());
  return m ? m[1] : null;
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
        /* The third way for a row to be unusable, once rounds may overlap: the
           date is covered by more than one round and no round claims the
           campaign. The per-row warnings say which campaign; this is the
           summary, and it should not send somebody to look at the dates. */
        "Or — where rounds run at the same time — more than one round covers the date and none claims the campaign.",
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
      db, "rounds", "round_id, client_id, start_date, end_date, country, market, code, session_date, campaigns",
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
  const rounds: Round[] = roundRows.filter((r) => r.client_id === clientId).map((r) => ({
    round_id: r.round_id, client_id: r.client_id,
    start_date: r.start_date, end_date: r.end_date,
    country: r.country,
    market: r.market,
    code: r.code,
    campaigns: r.campaigns ?? null,
    // fall back to the round's own column for a database that hasn't run 0025
    session_dates: sessionsByRound.get(r.round_id) ?? (r.session_date ? [r.session_date] : []),
  }));
  if (!rounds.length) throw new ImportError("This client has no rounds yet — create a round before importing.");
  return rounds;
}

async function loadLeadAdRuns(db: SupabaseClient, rounds: Round[]) {
  return fetchAll<AdSetRun>(db, "ads_performance", "ad_set, round_id, date",
    (q) => q.in("round_id", rounds.map((round) => round.round_id)).not("ad_set", "is", null));
}

function verifiedLeadDestinations(events: Plan["ops"]["events"], rounds: Round[], adRuns: AdSetRun[]): LeadDestination[] {
  const inferRound = leadAttributor(rounds, adRuns);
  const byId = new Map(rounds.map((round) => [round.round_id, round]));
  const destinations = new Map<string, LeadDestination>();
  for (const event of events) {
    const id = typeof event.round_id === "string" ? event.round_id : "";
    const round = byId.get(id);
    const method = event.attribution_method;
    const when = typeof event.event_date === "string" ? event.event_date : "";
    const stale = () => new ImportError("A lead destination is no longer valid. Upload and preview the Leads file again before committing.");
    if (event.event_type !== "lead" || id !== event.lead_round_id || !round || !when
        || toLeadTimestamp(when, "dmy") !== when) throw stale();
    if (method !== "declared") {
      const inferred = inferRound(when, typeof event.ad_set === "string" ? event.ad_set : null);
      if (inferred.roundId !== id || inferred.method !== method) throw stale();
    }
    const market = round.market ?? round.country;
    const label = (round.code || round.round_id) + (market ? ` · ${market}` : "");
    const destination = destinations.get(id) ?? { roundId: id, label, count: 0, declaredOutsideWindow: 0 };
    destination.count++;
    if (method === "declared" && !leadDateInRound(when, round)) destination.declaredOutsideWindow++;
    destinations.set(id, destination);
  }
  return [...destinations.values()].sort((a, b) => a.roundId.localeCompare(b.roundId));
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
  const pageKey = pageKeyOf(read.url_pattern, read.page_label);
  const priorQuery = db
    .from("scroll_runs")
    .select("run_id")
    .eq("client_id", clientId)
    .eq("round_id", round.round_id)
    .eq("device", read.device)
    .eq("captured_from", read.captured_from!)
    .eq("captured_to", read.captured_to!);
  /* THE PAGE IS PART OF WHAT MAKES TWO EXPORTS THE SAME EXPORT.
     Without it, LP2 imported over LP1's round, device and window matched LP1
     as a re-export and deleted it — two pages measured, one kept, and the
     screen showing the survivor as if it were the round. A null key has to
     match a null key rather than matching everything, or an unfiltered export
     re-inherits every page that ever ran in that window. */
  const { data: prior } = await (
    pageKey === null ? priorQuery.is("page_key", null) : priorQuery.eq("page_key", pageKey)
  ).maybeSingle();

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
        ? [`would replace the scroll curve already stored for ${round.round_id}`
           + ` (${pageKey ?? "no page filter"} · ${read.device}) over these dates`]
        : [],
    },
    warnings: [...new Set(warnings)],
    prerequisite: null,
    ops: {
      contacts: [], events: [], ads: [], unmatched: [], refundUpdates: [], answerUpdates: [],
      supersededParked: [], adoptedParked: [],
      scroll: {
        run: {
          run_id: runId,
          client_id: clientId,
          round_id: round.round_id,
          page_key: pageKey,
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
  { source, clientId, fileName, text, asContactId, reviewed }: {
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
    /** Server-resolved, after checking the active client's current journey. */
    reviewed?: {
      spec: SourceSpec; customAdMetrics: string[]; stageSlug?: string | null; binding?: string;
      profile?: MappingProfile; selected?: { id: string; revision: number };
    };
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
  let spec: SourceSpec | undefined = reviewed?.spec ?? (declaredMetric ? undefined : SOURCES[source as SourceKey]);
  if (declaredMetric && !reviewed) {
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

  const explicit = reviewed?.profile;
  const { data: remembered } = explicit && source !== "leads" ? { data: null } : await db
    .from("v_column_map").select("column_map").eq("client_id", clientId).eq("source", source).maybeSingle();

  const automatic = mapColumns(spec, headers, remembered?.column_map ?? null);
  const { map, missing, broken, unused } = explicit ? {
    map: { ...explicit.mapping }, missing: [], broken: [],
    unused: headers.filter((header) => !Object.values(explicit.mapping).includes(header)),
  } : automatic;

  if (missing.length) {
    const diagnostic = columnDiagnostics(spec, headers, { map, missing });
    throw new ImportError(diagnostic.error, diagnostic.detail);
  }

  const warnings: string[] = [];
  if (explicit && source === "leads" && unused.length) {
    warnings.push("Reviewed mappings do not import additional columns as Form Answers. Use automatic mapping for a supported Form Answers export.");
  }
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
    if (!s) return null;
    return explicit && ["date", "date_end", "event_date", "refund_date"].includes(field)
      ? normalizeProfileDate(s, explicit.rules.dateOrder) : s;
  };

  /**
   * WHICH WAY ROUND THIS FILE WRITES ITS SLASH DATES — decided once, here,
   * from the whole column, and then used for every row of it.
   *
   * Reading each value on its own is how a single column gets read two ways.
   * 9/17/2026 can only be month-first; 10/6/2026 proves nothing and used to
   * fall to the day-first default. Shely's attendance for 1026-01 did exactly
   * that: three dates in the column were 9/17, 9/24 and 9/30, the fourth was
   * 10/6, and it was stored as 10 June 2026. Forty people moved four months,
   * the October class showed nobody, and nothing failed.
   *
   * Every date field is pooled rather than judged separately, because they
   * come out of one export written by one tool and a column too short to
   * decide borrows the verdict of the ones that can.
   */
  const dateOrder: DateOrder = inferDateOrder(
    rows.flatMap((r) => ["date", "date_end", "event_date", "refund_date"].map((f) => val(r, f))),
  );
  if (dateOrder === "conflict") {
    warnings.push(
      "This file's dates are written both ways round — it contains a date that can only be day-first AND one that can only be month-first. Each row has been read on its own terms, which is the best that can be done; check the dates after importing, or re-export with one format.",
    );
  } else if (dateOrder === "ambiguous" && rows.some((r) => /^\d{1,2}[/-]\d{1,2}[/-]\d{4}/.test(val(r, "event_date") ?? val(r, "date") ?? ""))) {
    warnings.push(
      "Every slash date in this file could be read either way round (no value has a day above 12), so they have been read day-first — 6/10/2026 as 6 October. If this export is month-first, re-export with ISO dates (2026-10-06) before committing.",
    );
  }

  // Ads can carry measurements beyond delivery's four fixed columns. Match
  // only this client's declarations (plus global ones), persist the exact
  // header mapping, and leave an omitted declared measure absent rather than 0.
  const adMeasures = new Map<string, string>();
  if (source === "ads" && explicit) {
    for (const metric of reviewed?.customAdMetrics ?? []) {
      const header = map[`ad_measure:${metric}`];
      if (header) adMeasures.set(metric, header);
    }
  } else if (source === "ads") {
    const { data, error } = await db.from("journey_metrics")
      .select("metric, aliases, client_id").eq("source", "ads");
    if (error) throw new ImportError(`Could not read declared ads measures: ${error.message}`);
    const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    for (const row of (data ?? []) as Array<{ metric: string; aliases: string[] | null; client_id: string | null }>) {
      if (row.client_id !== null && row.client_id !== clientId) continue;
      const choices = [row.metric, ...(row.aliases ?? [])].map(canon);
      const header = headers.find((h) => choices.includes(canon(h)));
      if (header) adMeasures.set(row.metric, header);
    }
  }

  /**
   * GoHighLevel keeps form answers as ordinary export columns.  Preserve every
   * non-identity extra on lead rows, verbatim, rather than teaching the schema
   * a new column every time a form changes.  The known name/contact columns
   * are deliberately excluded: they describe the person, not an answer.
   *
   * WHAT THE CRM WROTE IS NOT WHAT THE REGISTRANT ANSWERED.
   *
   * "Every column I was not told to use is an answer" is one rule short. A
   * GoHighLevel contacts export ships its own bookkeeping in the same row —
   * Last Activity, Tags, Business Name — and all three arrived on the Form
   * answers screen as questions. "Last Activity" listed 34 timestamps as if
   * they were replies, the largest of them 256 people who share a minute; a
   * reader scanning that page for what registrants said found two real
   * questions buried under two the form never asked.
   *
   * Excluded here rather than hidden at the far end, because a value nobody
   * answered is not an answer at any point downstream. Excluding is safe in a
   * way including is not: a system field wrongly kept becomes a question on a
   * client-facing screen, while a question wrongly dropped comes back in full
   * on the next import — the enrichment path merges into what is already
   * stored and never deletes.
   */
  const CRM_FIELD =
    /^(contact\s*id|full\s*name|first\s*name|last\s*name|business\s*name|company(\s*name)?|tags?|last\s*activity|date\s*(created|updated|added)|created(\s*(on|at))?|updated(\s*(on|at))?|assigned\s*user|followers|time\s*zone|timezone|dnd|additional\s*(emails?|phones?))$/i;
  const answerHeaders = source === "leads" && !explicit
    ? unused.filter((h) => !CRM_FIELD.test(h))
    : [];
  const answersFor = (r: Row) => Object.fromEntries(
    answerHeaders.flatMap((header) => {
      const value = r[header]?.trim();
      return value ? [[header, value]] : [];
    }),
  );

  /**
   * A CONTACTS EXPORT IS NOT A LEADS EXPORT.
   *
   * The form questions live in GoHighLevel's contacts list, and that export
   * carries none of the columns a lead is attributed by — no round, no
   * utm_term, no utm_content, no utm_campaign, no source. Its date column is
   * when the CONTACT was created, which is not when they opted in to anything.
   *
   * Fed through the normal path it looked reasonable and was not: 47 new leads
   * on the first real file, every one placed by a date guess. Twenty-odd were
   * people already counted, given a second lead row in a round they never
   * registered for; the leads total would have gone 1,889 to 1,936 and stopped
   * matching the client's own sheet, with nothing on screen saying why.
   *
   * BOTH conditions are needed. A thin leads file of just email and date names
   * no campaign either, and it is still a leads file — organic people, placed
   * by the round their opt-in date falls in, which is the right answer for
   * them. What marks a contacts export is that it arrives carrying ANSWERS and
   * no way to attribute anything. It came for the answers, not for the leads.
   */
  const ATTRIBUTION_FIELDS = ["round_id", "utm_campaign", "ad_set", "ad", "source"] as const;
  if (source === "leads" && explicit) {
    const couldBeAnswers = (columns: string[]) => columns.some((h) => !CRM_FIELD.test(h));
    const baselineEnrichment = automatic.missing.length === 0 && couldBeAnswers(automatic.unused)
      && ATTRIBUTION_FIELDS.every((f) => !(f in automatic.map));
    const unclearAttribution = couldBeAnswers(unused)
      && rows.some((row) => ATTRIBUTION_FIELDS.every((f) => !val(row, f)));
    if (baselineEnrichment || unclearAttribution) {
      throw new ImportError(
        "This looks like a contacts or Form Answers export. Use automatic mapping so it cannot create new leads.",
        ["Reviewed lead mappings with extra columns need clear attribution for every row."],
      );
    }
  }
  const enrichOnly = source === "leads"
    && answerHeaders.length > 0
    && ATTRIBUTION_FIELDS.every((f) => !(f in map));
  if (enrichOnly) {
    warnings.push(
      "This file names no round, campaign, ad set or source, so it cannot say which " +
      "round a new lead belongs to — its date column is when the contact was created, " +
      "not when they opted in. Existing leads will gain their form answers; no new lead " +
      "will be created from it.",
    );
  }

  // ── reference data ───────────────────────────────────────────────────────
  const rounds = await loadRounds(db, clientId);

  const roundIds = rounds.map((r) => r.round_id);

  const plan: Plan = {
    source, clientId, fileName, columnMap: map, unusedColumns: unused,
    ...(explicit ? { review: {
      stageSlug: reviewed?.stageSlug, binding: reviewed?.binding, dateOrder: explicit.rules.dateOrder,
      ...(reviewed?.selected ? { profile: { ...reviewed.selected, name: explicit.name } } : {}),
    } } : {}),
    rowCount: rows.length,
    coverage: { start: null, end: null },
    counts: { matchedExact: 0, matchedAuto: 0, newContacts: 0, parked: 0, duplicates: 0, unidentified: 0 },
    attribution: { utm: 0, dateWindow: 0, none: 0 },
    diff: { newRows: 0, changedRows: 0, restatements: [] },
    warnings,
    prerequisite: null,
    ops: { contacts: [], events: [], ads: [], unmatched: [], refundUpdates: [], answerUpdates: [], supersededParked: [], adoptedParked: [], scroll: null },
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
    const existing = await fetchAll<AdsComparable>(db, "ads_performance",
      "round_id, date, campaign, ad_set, ad, ad_id, channel, spend, impressions, reach, clicks, measures",
      (q) => q.in("round_id", roundIds));
    const byKey = new Map<string, AdsComparable[]>();
    const stable = new Map<string, AdsComparable>();
    const idKey = (r: AdsIdentity) => JSON.stringify([r.round_id, r.date, r.channel ?? ASSUMED_CHANNEL, r.ad_id]);
    function remember(row: AdsComparable) {
      const key = adsKey(row);
      const matches = byKey.get(key) ?? [];
      matches.push(row);
      byKey.set(key, matches);
      if (row.ad_id) stable.set(idKey(row), row);
    }
    const priorStarts = new Map<string, Set<string>>();
    const earliestPriorStart = new Map<string, string>();
    const windows = new Map<string, Map<string, string>>();
    const grains = new Map<string, { campaign: boolean; sets: Set<string>; creativeSets: Set<string> }>();
    const additive = (r: AdsComparable) =>
      r.spend != null && Number(r.spend) !== 0 || r.impressions != null && Number(r.impressions) !== 0 ||
      r.clicks != null && Number(r.clicks) !== 0 ||
      Object.values(r.measures ?? {}).some((m) => m != null && Number(m) !== 0);
    function trackGrain(row: AdsComparable, incoming: boolean) {
      // A separate reach-only row is an intentional Meta pull measurement.
      if (!row.campaign || !additive(row)) return;
      const key = JSON.stringify([row.round_id, row.date, row.channel ?? ASSUMED_CHANNEL, row.campaign]);
      const g = grains.get(key) ?? { campaign: false, sets: new Set<string>(), creativeSets: new Set<string>() };
      const isCampaign = !row.ad_set && !row.ad;
      const set = row.ad_set ?? "";
      if (incoming && (isCampaign ? g.sets.size > 0 || g.creativeSets.size > 0
        : g.campaign || (row.ad ? g.sets.has(set) : g.creativeSets.has(set)))) {
        throw new ImportError("This ads export mixes totals and breakdown rows for the same campaign, round and reporting start. Export only the breakdown level already stored, or reconcile the existing totals before importing.");
      }
      if (isCampaign) g.campaign = true;
      else (row.ad ? g.creativeSets : g.sets).add(set);
      grains.set(key, g);
    }
    for (const row of existing) {
      remember(row);
      trackGrain(row, false);
      const series = adSeriesKey(row);
      const starts = priorStarts.get(series) ?? new Set<string>();
      starts.add(row.date);
      priorStarts.set(series, starts);
      if (!earliestPriorStart.has(series) || row.date < earliestPriorStart.get(series)!) {
        earliestPriorStart.set(series, row.date);
      }
    }

    for (const r of rows) {
      const date = toDate(val(r, "date"), dateOrder);
      if (!date) { unusable++; continue; }
      track(date);
      // a period-level export's window ends later than its start date, and the
      // batch's coverage should say so
      const dateEndRaw = val(r, "date_end");
      const dateEnd = toDate(dateEndRaw, dateOrder);
      if (dateEndRaw && (!dateEnd || dateEnd < date)) throw new ImportError("An ads row has an invalid reporting end date. Re-export with valid dates.");
      track(dateEnd);

      const adSet = normAsset(val(r, "ad_set"));
      const ad = normAsset(val(r, "ad"));
      const campaign = val(r, "campaign");

      /**
       * WHICH ROUND A DAY OF SPEND BELONGS TO.
       *
       * The market first, then the date, then the name. Each step exists for a
       * reason that cost something to learn.
       *
       * THE MARKET, from the campaign name, narrows the candidates. Once MY and
       * SG run their own schedules their windows overlap, and asking "which
       * round covers this day" returns two answers with array order picking the
       * winner. Reading DF_MY_ / DF_SG_ first makes that question unambiguous
       * again, because one market's own rounds never overlap each other.
       *
       * THE DATE then decides, because spend belongs to the round it was spent
       * during. Campaigns keep running after their round closes:
       * DF_SG_..._0726_01_AI_LP spent $596.99 inside 0726-02's week, and that
       * money bought 0726-02's leads whatever the campaign is called.
       *
       * THE NAME is the fallback for a period-level export, where every row
       * carries the first date of the reporting window and no round contains it.
       *
       * Putting the name first instead reverses that ruling and re-files
       * $7,500.26 across nine rounds the moment anything is re-imported — while
       * the account total stays 22,865.78, so nothing on screen would say so.
       * Which is why the OWNED-CAMPAIGN step below sits after the date and not
       * before it, even though it is the more direct answer when it applies.
       */
      const campaignRound = roundFromCampaign(campaign, rounds);
      const market = countryOf(campaign);
      const dateCandidates = rounds.filter((x) =>
        (!market || !x.market || x.market.toUpperCase() === market) &&
        dayOf(x.start_date)! <= date && date <= dayOf(x.end_date)!,
      );
      /**
       * THE CAMPAIGN A ROUND OWNS — for rounds that run at the same time.
       *
       * Only consulted where the date has come back with more than one answer,
       * which for consecutive weekly rounds is never. A client like FWD i-Care
       * runs three experiments over one window, so every one of its days is
       * ambiguous by date and this is the step that decides.
       *
       * Ahead of campaignRound because it is exact and explicit: a name the
       * round was given, rather than a round code spotted inside a string.
       */
      const ownedRound = dateCandidates.length > 1
        ? roundOwningCampaign(campaign, dateCandidates)
        : null;
      const round =
        (dateCandidates.length === 1 ? dateCandidates[0] : null) ?? ownedRound ?? campaignRound;
      // Two rounds still covering one day after the market has narrowed them,
      // with nothing naming which, is a schedule the app cannot read. Say so
      // rather than taking the first.
      if (dateCandidates.length > 1 && !ownedRound && !campaignRound) {
        warnings.push(
          `More than one round covers ${date}${market ? ` in ${market}` : ""}, and no round claims "${campaign}" — so that ads row was not imported. Rounds that run at the same time have to name the campaigns they own.`,
        );
      }
      if (!round) {
        warnings.push(
          `No round covers ${date}${campaign ? ` and no round is named in "${campaign}"` : ""} — ` +
          `${rows.length > 1 ? "some ads rows" : "that row"} would have no round.`,
        );
        unusable++;
        continue;
      }
      const incoming = {
        round_id: round.round_id, date, campaign, ad_set: adSet, ad,
        ad_id: val(r, "ad_id") || null,
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
        measures: Object.fromEntries([...adMeasures].flatMap(([metric, header]) => {
          const measured = toNumber(r[header]?.trim() || null);
          return measured === null ? [] : [[metric, measured]];
        })),
      };
      const key = adsKey(incoming);
      const series = adSeriesKey(incoming);
      const starts = windows.get(series) ?? new Map<string, string>();
      const end = dateEnd ?? date;
      if (starts.has(date) && starts.get(date) !== end) {
        throw new ImportError("This file reports different date windows for the same ads row. Re-export at one consistent daily breakdown.");
      }
      starts.set(date, end);
      windows.set(series, starts);
      const prior = byKey.get(key) ?? [];
      const sameId = incoming.ad_id ? stable.get(idKey(incoming)) : undefined;
      if (sameId && adsKey(sameId) !== key) {
        throw new ImportError("This ad ID is already stored for this round and day under different names. Verify the rename against the existing data before importing.");
      }
      if (prior.length) {
        if (prior.some((old) => changedAdMeasurement(old, incoming))) {
          throw new ImportError("This ads file changes a measurement already stored for the same round, reporting start and asset. Review the original export and use a separately reviewed correction; this upload did not change the existing row.");
        }
        plan.counts.duplicates++;
        continue;
      }
      const earlier = earliestPriorStart.get(series);
      if (earlier && earlier < date) {
        warnings.push("This file adds later rows for an ads series already stored. Earlier rows have no stored reporting end, so GT cannot rule out overlap with a historical period total. Before committing, verify the prior export used daily rows or reconcile it against the original reporting window.");
      }
      trackGrain(incoming, true);
      remember(incoming);
      plan.ops.ads.push({ id: uploadedAdId(clientId, key), ...incoming });
      plan.diff.newRows++;
    }

    for (const [series, starts] of windows) {
      const known = [...(priorStarts.get(series) ?? [])].sort();
      let endOfPriorIncoming = "", next = 0;
      for (const [start, end] of [...starts].sort(([a], [b]) => a.localeCompare(b))) {
        // A historical row only stores its start. Never fabricate its end.
        while (next < known.length && known[next] <= start) next++;
        if (start <= endOfPriorIncoming || (next < known.length && known[next] <= end)) {
          throw new ImportError("An ads reporting window overlaps another row for the same round and asset. Re-export with daily rows, or reconcile the existing window before importing.");
        }
        if (end > endOfPriorIncoming) endOfPriorIncoming = end;
      }
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
    event_date: string; product: string | null; amount: string | null; refund_amount: string | null; refund_date?: string | null;
    lead_round_id: string | null; source: string | null;
    anon_key: string | null;
    utm_campaign: string | null;
    answers: Record<string, string> | null;
  }>(db, "events",
    "event_id, contact_id, round_id, event_type, event_date, product, amount, refund_amount, refund_date, lead_round_id, source, anon_key, utm_campaign, answers",
    (q) => q.in("round_id", roundIds));

  const adRuns = source === "leads" ? await loadLeadAdRuns(db, rounds) : [];
  type LeadPlacement = { when: string; roundId: string; method: "declared" | "utm" | "date_window" };
  const placements: Array<LeadPlacement | null> = [];
  if (source === "leads") {
    const inferRound = leadAttributor(rounds, adRuns);
    const details: string[] = [];
    let blocked = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const when = toLeadTimestamp(val(row, "event_date"), dateOrder);
      const declared = val(row, "round_id");
      const exact = declared ? declaredLeadRound(declared, rounds) : null;
      const inferred = !declared && when ? inferRound(when, normAsset(val(row, "ad_set"))) : null;
      const roundId = exact?.round_id ?? inferred?.roundId;
      const method = exact ? "declared" : inferred?.method;
      placements[i] = when && roundId && method ? { when, roundId, method } : null;
      // Contacts/Form Answers enrichment never stages a new lead. A row
      // without enough evidence cannot enrich an existing lead either.
      if (!placements[i] && !enrichOnly) {
        blocked++;
        if (details.length < 8) {
          const why = !when ? "missing or invalid opt-in date; use a real date such as YYYY-MM-DD."
            : declared ? "the listed Round is not a unique round for this client; use its exact ID or unique code."
            : "no unique round covers this opt-in date; check the date or add the correct Round ID or code.";
          details.push(`Data row ${i + 1}: ${why}`);
        }
      }
    }
    if (blocked) throw new ImportError(
      `Leads import blocked: ${blocked} ${blocked === 1 ? "row needs" : "rows need"} a valid opt-in date and a confirmed round. Correct the file and preview again.`,
      details,
    );
  }

  // ── Was the file this one depends on actually committed? ─────────────────
  // Skipped for the unmatched-queue replay, which imports one already-known
  // person and legitimately has no interest in what else is in the database.
  if (!asContactId) {
    if (source === "leads" && !adRuns.length) {
      plan.prerequisite =
        "No committed ad sets are available to help match leads. A valid explicit Round still works; " +
        "otherwise the opt-in date must identify one eligible round. Targeted views may have no delivery data.";
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
   * June was acquired in May; June inherited them. Attribution can later
   * present that history under a different credit model, but it must not turn
   * the later lead into the acquisition event.
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
  /** The same keys, pointing at the row, so a duplicate can still be enriched. */
  const eventByKey = new Map(
    events.map((e) => [
      eventKey(e.event_type, e.anon_key ?? e.contact_id ?? "", e.round_id, e.event_date, e.product),
      e,
    ]),
  );

  /**
   * A duplicate lead carrying answers the stored row does not have.
   *
   * Only ever adds: a key already present keeps its stored value, so
   * re-importing an older export cannot overwrite a newer answer. Returns true
   * when something was actually queued, so the diff can count it.
   */
  const enrich = (key: string, incoming: Record<string, string>): boolean => {
    if (!Object.keys(incoming).length) return false;
    const prior = eventByKey.get(key);
    if (!prior || prior.event_type !== "lead") return false;
    const have = prior.answers ?? {};
    const merged = { ...have };
    let added = 0;
    for (const [k, v] of Object.entries(incoming)) {
      if (have[k] === undefined && v) { merged[k] = v; added++; }
    }
    if (!added) return false;
    plan.ops.answerUpdates.push({ event_id: prior.event_id, answers: merged });
    prior.answers = merged;  // a later row in the same file sees it too
    return true;
  };

  const stagedSales = new Map<string, { amount: number; providedRefund: number | null; refundDate: string | null }>();
  const salesByKey = new Map<string, typeof events>();
  const salesKey = (contactId: string, when: string, product: string) => JSON.stringify([contactId, sgDayOf(when), product]);
  for (const e of events) {
    if (e.event_type !== "sale" || !e.contact_id || !e.product) continue;
    const key = salesKey(e.contact_id, e.event_date, e.product);
    const matching = salesByKey.get(key) ?? [];
    matching.push(e);
    salesByKey.set(key, matching);
  }

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
  // Sales export metadata can change while transaction evidence is identical.
  // Do not create a second held amount just because an unused note changed.
  // No identity/date/product/amount means there is no safe semantic key.
  function heldSaleEvidence(raw: Row, read: typeof val, order: DateOrder) {
    if (source !== "sales" || explicit) return null;
    const email = normEmail(read(raw, "email")), phone = normPhone(read(raw, "phone"));
    const when = toTimestamp(read(raw, "event_date"), order);
    const product = resolveProduct(read(raw, "product") ?? "");
    const amount = toNumber(read(raw, "amount"));
    if ((!email && !phone) || !when || !product || amount === null) return null;
    // Full explicit identity tuple: never guess the person from a name, partial
    // phone or a single shared address when the other evidence disagrees.
    return {
      key: JSON.stringify([email, phone, sgDayOf(when), product]),
      value: JSON.stringify([comparableMetric("amount", amount), toNumber(read(raw, "refund_amount")), toDate(read(raw, "refund_date"), order)]),
    };
  }
  const heldSaleRows = new Map<string, { row_id: string | null; value: string }[]>();
  for (const old of stillParked) {
    if (!old.raw_data || typeof old.raw_data !== "object") continue;
    const raw = old.raw_data as Row;
    const priorMap = mapColumns(spec, Object.keys(raw), null).map;
    const read = (r: Row, f: string) => String(r[priorMap[f]] ?? "").trim() || null;
    const order = inferDateOrder([read(raw, "event_date"), read(raw, "refund_date")]);
    // No upload-level date-order evidence remains in this old raw row.
    if (order === "ambiguous" && /^\d{1,2}[/-]\d{1,2}[/-]/.test(read(raw, "event_date") ?? "")) continue;
    const evidence = heldSaleEvidence(raw, read, order);
    if (!evidence) continue;
    const before = heldSaleRows.get(evidence.key) ?? [];
    before.push({ row_id: old.row_id, value: evidence.value });
    heldSaleRows.set(evidence.key, before);
  }
  function heldEvidenceMatch(raw: Row) {
    const evidence = heldSaleEvidence(raw, val, dateOrder);
    const prior = evidence ? heldSaleRows.get(evidence.key) : undefined;
    if (prior?.length && (prior.length > 1 || prior[0].value !== evidence!.value)) {
      throw new ImportError("This sale conflicts with a waiting row for the same buyer, local day and product. Reconcile it in Unmatched before uploading; the file has no transaction ID to distinguish them.");
    }
    return { prior: prior?.[0], evidence };
  }

  /** This exact row is in the queue, and this import can finally count it. */
  const supersede = (raw: Row, contactId: string) => {
    const rowId = parkedRowIds.get(parkKey(raw)) ?? heldEvidenceMatch(raw).prior?.row_id;
    if (rowId) plan.ops.supersededParked.push({ row_id: rowId, contact_id: contactId });
  };

  const park = (reason: ParkReason, raw: Row, bestGuess: string | null, guessMethod: string | null, confidence: string, held = 0) => {
    const key = parkKey(raw);
    if (parked.has(key)) {
      plan.counts.duplicates++;
      // It is already waiting. Preserve the original queue row and record
      // that the preview encountered it (including for mapping review).
      const existing = parkedRowIds.get(key);
      if (existing) plan.ops.adoptedParked.push(existing);
      return;
    }
    const { prior, evidence } = heldEvidenceMatch(raw);
    if (prior) {
      plan.counts.duplicates++;
      if (prior.row_id) plan.ops.adoptedParked.push(prior.row_id);
      return;
    }
    if (evidence) heldSaleRows.set(evidence.key, [{ row_id: null, value: evidence.value }]);
    parked.add(key);
    plan.ops.unmatched.push({
      row_id: uuid(), source, client_id: clientId, raw_data: raw,
      reason, best_guess: bestGuess, guess_method: guessMethod, confidence,
      revenue_held: held, auto_resolved: false,
    });
    plan.counts.parked++;
  };

  for (const [rowIndex, r] of rows.entries()) {
    const placement = placements[rowIndex];
    if (source === "leads" && !placement) { plan.counts.duplicates++; continue; }
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
    else if (outcome.kind === "new") {
      // A contacts export brings people this app has never seen, and without a
      // round or a campaign there is nothing to attach them to. Creating the
      // person and no lead would leave a contact belonging to nothing.
      if (enrichOnly) { plan.counts.duplicates++; continue; }
      contactId = addContact(email, phone);
    }

    // ── LEADS ──────────────────────────────────────────────────────────────
    if (source === "leads") {
      const { when, roundId, method } = placement!;
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
        if (!anon) {
          park(outcome.kind === "park" ? outcome.reason : "name_only", r, null, null, "none");
          continue;
        }
        const anonSet = normAsset(val(r, "ad_set"));
        if (method === "utm") plan.attribution.utm++;
        else if (method === "date_window") plan.attribution.dateWindow++;
        const key = eventKey("lead", anon, roundId, when);
        if (seenEvents.has(key)) {
          if (enrich(key, answersFor(r))) plan.diff.changedRows++;
          plan.counts.duplicates++;
          continue;
        }
        // Nothing in this file can say which round an unseen lead belongs to.
        if (enrichOnly) { plan.counts.duplicates++; continue; }
        seenEvents.add(key);
        track(sgDayOf(when));
        plan.ops.events.push({
          event_id: uuid(), contact_id: null, round_id: roundId, event_type: "lead", anon_key: anon,
          event_date: when, lead_round_id: roundId, attribution_method: method,
          utm_campaign: val(r, "utm_campaign") || null,
          ad_set: anonSet, ad: normAsset(val(r, "ad")),
          // Never "Paid Ads" by inference. A row the ads could have produced
          // would also have carried an address; this one didn't, so the file's
          // own answer stands or it is organic.
          source: val(r, "source") || "Organic",
          answers: answersFor(r),
          match_status: "unidentified",
        });
        plan.counts.unidentified++;
        plan.diff.newRows++;
        continue;
      }
      track(sgDayOf(when));
      const adSet = normAsset(val(r, "ad_set"));
      const adName = normAsset(val(r, "ad"));
      const utm = val(r, "utm_campaign");
      if (method === "utm") plan.attribution.utm++;
      else if (method === "date_window") plan.attribution.dateWindow++;

      const key = eventKey("lead", contactId, roundId, when);
      if (seenEvents.has(key)) {
        if (enrich(key, answersFor(r))) plan.diff.changedRows++;
        plan.counts.duplicates++;
        continue;
      }
      /*
       * The person is here but this round/day is not, which on a contacts
       * export means their contact-creation date landed in a round they never
       * registered for. Creating the lead would count them twice.
       */
      if (enrichOnly) { plan.counts.duplicates++; continue; }
      seenEvents.add(key);

      const src = val(r, "source") || (adSet ? "Paid Ads" : "Organic");
      plan.ops.events.push({
        event_id: uuid(), contact_id: contactId, round_id: roundId, event_type: "lead",
        event_date: when, lead_round_id: roundId, attribution_method: method,
        utm_campaign: utm || null, ad_set: adSet, ad: adName,
        source: src, variant: val(r, "variant"),
        answers: answersFor(r),
        match_status: outcome.kind === "auto" ? "auto_resolved" : "matched",
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
         * to pretend otherwise — the event carries no contact, cannot take
         * revenue, and cannot be resolved
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
        const anonWhen = toTimestamp(val(r, "event_date"), dateOrder)
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
      const when = toTimestamp(val(r, "event_date"), dateOrder)
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
        variant: val(r, "variant"),
        match_status: outcome.kind === "auto" ? "auto_resolved" : "matched",
      });
      supersede(r, contactId);
      /**
       * Only a class determines the purchase round when a buyer attended.
       *
       * A declared stage is not a class — an appointment is not the room
       * somebody bought in — so it must not move that choice. This
       * attendance-specific rule is gated on the event type rather than on the
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
      const when = toTimestamp(val(r, "event_date"), dateOrder);
      const amount = toNumber(val(r, "amount"));
      const productRaw = val(r, "product") ?? "";
      const product = resolveProduct(productRaw);
      const providedRefund = toNumber(val(r, "refund_amount"));
      const refund = providedRefund ?? 0;
      const refundDate = toDate(val(r, "refund_date"), dateOrder);

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

      // No transaction ID exists. Use the current coarse business rule, but
      // refuse conflicting amounts or multiple possible stored targets.
      const saleIdentity = salesKey(contactId, when, product);
      const earlier = stagedSales.get(saleIdentity);
      if (earlier) {
        if (comparableMetric("amount", earlier.amount) !== comparableMetric("amount", amount) ||
            earlier.providedRefund !== providedRefund || earlier.refundDate !== refundDate) {
          throw new ImportError("This file has conflicting sales for the same person, local day and product. The export has no transaction IDs to resolve them; check the source transactions.");
        }
        plan.counts.duplicates++;
        continue;
      }
      stagedSales.set(saleIdentity, { amount, providedRefund, refundDate });
      const matches = salesByKey.get(saleIdentity) ?? [];
      if (matches.length > 1) throw new ImportError("More than one stored sale matches this person, local day and product. Reconcile the source transactions before importing.");
      const prior = matches[0];
      if (prior) {
        if (prior.amount != null && comparableMetric("amount", prior.amount) !== comparableMetric("amount", amount)) {
          throw new ImportError("This sale differs in amount from a stored sale for the same person, local day and product. The export has no transaction ID to tell a correction from a second sale. Reconcile the original transaction before importing.");
        }
        const priorRefund = Number(prior.refund_amount ?? 0);
        if (refundDate && (providedRefund === null || providedRefund === priorRefund) &&
            refundDate !== (prior.refund_date ?? null)) {
          throw new ImportError("This sale supplies a different refund date without a different refund amount. Reconcile the existing refund before importing; the file does not identify a separate refund.");
        }
        if (providedRefund !== null && refund !== priorRefund) {
          plan.ops.refundUpdates.push({ event_id: prior.event_id, refund_amount: refund, refund_date: refundDate });
          plan.diff.changedRows++;
          plan.diff.restatements.push(
            `would restate ${prior.lead_round_id ?? prior.round_id} revenue by ${(priorRefund - refund).toFixed(2)} — refund on ${productRaw} — review`,
          );
        } else {
          plan.counts.duplicates++;
        }
        supersede(r, contactId);
        continue;
      }

      const key = eventKey("sale", contactId, purchaseRound, when, product);
      if (seenEvents.has(key)) { plan.counts.duplicates++; continue; }
      seenEvents.add(key);

      plan.ops.events.push({
        event_id: uuid(), contact_id: contactId, round_id: purchaseRound, event_type: "sale",
        event_date: when, product, amount,
        refund_amount: refund, refund_date: refundDate,
        // Revenue is attributed at read time to the qualifying lead; the
        // purchase round remains the class/date resolution above.
        lead_round_id: leadRound,
        // The acquiring lead wins wherever there is one — a payments export does
        // not get to restate how somebody was acquired. The column answers only
        // where no lead can. See sourceFor above and the note in sources.ts.
        source: sourceFor(contactId, when, val(r, "source")),
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
  if (source === "leads") plan.leadRoundGuard = {
    version: LEAD_ROUND_GUARD_VERSION,
    destinations: verifiedLeadDestinations(plan.ops.events, rounds, adRuns),
  };
  return plan;
}

export function hasImportWrites(plan: Plan): boolean {
  const ops = plan.ops;
  return Boolean(ops.contacts.length || ops.ads.length || ops.events.length ||
    ops.unmatched.length || ops.refundUpdates.length || ops.answerUpdates.length ||
    ops.supersededParked.length || ops.scroll);
}

/** Step 5 — writes the approved plan. Nothing before this touches the data. */
export async function commitPlan(db: SupabaseClient, batchId: string, plan: Plan): Promise<{ changed: boolean }> {
  if (plan.source === "leads") {
    const guard = plan.leadRoundGuard;
    if (guard?.version !== LEAD_ROUND_GUARD_VERSION || !Array.isArray(guard.destinations)) {
      throw new ImportError("This Leads preview predates round validation. Upload and preview the file again before committing.");
    }
    const rounds = plan.ops.events.length ? await loadRounds(db, plan.clientId) : [];
    const needsAds = plan.ops.events.some((event) => event.attribution_method !== "declared" && event.ad_set);
    const current = verifiedLeadDestinations(plan.ops.events, rounds, needsAds ? await loadLeadAdRuns(db, rounds) : []);
    // JSONB normalizes object key order; compare structured values explicitly.
    if (current.length !== guard.destinations.length || current.some((row, i) => {
      const saved = guard.destinations[i];
      return !saved || row.roundId !== saved.roundId || row.label !== saved.label
        || row.count !== saved.count || row.declaredOutsideWindow !== saved.declaredOutsideWindow;
    })) {
      throw new ImportError("Lead round destinations changed since preview. Upload and preview the file again before committing.");
    }
  }
  if (!hasImportWrites(plan)) {
    const { error } = await db.from("import_batches")
      .update({ status: "discarded", staged_payload: null }).eq("batch_id", batchId).eq("status", "staged");
    if (error) throw new ImportError(`Closing the unchanged preview failed: ${error.message}`);
    return { changed: false };
  }
  const chunk = <T,>(a: T[], n = 500) =>
    Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

  if (plan.ops.ads.length) {
    // Preview and Commit are separate requests. If another writer (including
    // direct Meta pull) landed these exact names meanwhile, do not quietly
    // commit a different diff. The UUID primary key also closes the exact-key
    // upload race in the remaining check-to-insert window.
    const ads = plan.ops.ads as unknown as (AdsIdentity & { id: string })[];
    if (ads.some((r) => r.id !== uploadedAdId(plan.clientId, adsKey(r)))) {
      throw new ImportError("This ads preview predates duplicate protection. Upload the file again before committing.");
    }
    const keys = new Set(ads.map(adsKey));
    const roundIds = [...new Set(ads.map((r) => r.round_id))];
    const stored = await fetchAll<AdsIdentity>(db, "ads_performance",
      "round_id, date, campaign, ad_set, ad, channel", (q) => q.in("round_id", roundIds));
    if (stored.some((r) => keys.has(adsKey(r)))) {
      throw new ImportError("Ads data changed since this preview. Upload the file again to review what is already stored.");
    }
  }
  for (const part of chunk(plan.ops.contacts)) {
    const { error } = await db.from("contacts").insert(part);
    if (error) throw new ImportError(`Writing contacts failed: ${error.message}`);
  }
  for (const part of chunk(plan.ops.ads.map((a) => ({ ...a, import_batch_id: batchId })))) {
    const { error } = await db.from("ads_performance").insert(part);
    if (error?.code === "23505") throw new ImportError("An ads row was committed by another request. Upload again to review what is already stored.");
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
    /**
     * THE CURVE GOES ON THE RUN, and this is the half that was missing.
     *
     * 0092 moved the read side onto scroll_runs.points — it added the column,
     * backfilled every existing run out of scroll_depths, and pointed
     * v_scroll_runs at it. The write side was never moved with it, so every
     * scroll import after 0092 wrote its readings to scroll_depths and left
     * points at its '[]' default.
     *
     * Nothing threw. The run appeared in the list with the right sessions and
     * the right window, and the curve was simply absent — a screen that looks
     * identical to a page nobody has measured yet. Found by reading the two real
     * 0926-01 exports back through the anon key after committing them, which is
     * the only place the difference shows.
     *
     * `depth`, not `depth_pct`: the jsonb shape is the one 0092's backfill
     * produced and curveOf() reads. The two writes below are built from the same
     * array so they cannot disagree — scroll_depths is now an audit copy that
     * nothing reads, kept because dropping a table is a separate decision.
     */
    const points = s.points.map((p) => ({
      depth: p.depth_pct, visitors: p.visitors, drop_off_pct: p.drop_off_pct,
    }));

    const { error: e1 } = await db.from("scroll_runs").insert({ ...s.run, points, import_batch_id: batchId });
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
  /**
   * Answers onto leads that were already here.
   *
   * Written one row at a time like the refunds above, and for the same reason:
   * each carries its own event_id and there is no shape that updates many rows
   * with different values in one statement. A few hundred is fine; this runs
   * once per export, not once per read.
   */
  for (const u of plan.ops.answerUpdates) {
    const { error } = await db.from("events")
      .update({ answers: u.answers })
      .eq("event_id", u.event_id);
    if (error) throw new ImportError(`Writing form answers failed: ${error.message}`);
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

  // An upload may be a subset even if its min/max dates cover an older batch.
  // Exact repeats are already deduped at preview; absence from an upload is
  // not proof a waiting row was resolved. Only superseding a match above can
  // retire it. Keep unchanged parked rows attached to their original batch.

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

  /**
   * THE CAMPAIGN LOOKUP IS CACHED, SO AN IMPORT HAS TO SAY SO.
   *
   * mv_campaign_dimensions holds every campaign resolved to its market and
   * landing page. Five views read it and one page load used to rebuild it four
   * times, which was about half the database floor; it is a materialised view
   * now and only changes when a file lands or a rule is edited.
   *
   * A file has just landed. Any campaign it introduced has no row until this
   * runs, and until then it reads as no market and no landing page — an
   * understatement, in the same direction as the unmatched queue, but an
   * understatement nobody asked for.
   *
   * Deliberately AFTER the batch is closed and deliberately not fatal. The rows
   * are already written and the import succeeded; a refresh that fails must not
   * turn a good import into an error the user retries. It is reported instead,
   * and the Refresh data button runs the same function.
   */
  const { error: refreshError } = await db.rpc("fo_refresh_lookups");
  if (refreshError) {
    console.error(
      `Import committed, but refreshing the campaign lookup failed: ${refreshError.message}. ` +
      `Campaigns new to this file will read as having no market until it runs — ` +
      `press Refresh data, or run: select fo_refresh_lookups();`,
    );
  }
  return { changed: true };
}
