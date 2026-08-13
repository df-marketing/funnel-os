import { unstable_cache } from "next/cache";
import { createReadClient, FUNNEL_TAG } from "@/lib/supabase/read";
import type { Metrics } from "./spine";

export type Client = {
  client_id: string;
  client_name: string | null;
  client_note: string | null;
  stage_count: number;
};

export type Stage = {
  client_id: string;
  stage_order: number;
  stage_name: string;
  stage_slug: string;
  compare_dimension: string | null;
  stage_metric: string | null;
  stage_rate_label: string | null;
};

export type StripCard = Stage & { value: string | null; rate: string | null };

export type Cut = {
  cut_key: string;
  cut_label: string;
  cut_sub: string | null;
  m: Metrics;
};

export type ImportStatus = {
  client_id: string | null;
  source: string;
  imported_at: string;
  coverage_start: string | null;
  coverage_end: string | null;
  row_count: number | null;
  is_stale: boolean;
  days_since: number;
};

export type UnmatchedSummary = {
  waiting: number;
  auto_resolved: number;
  revenue_held: number;
  sales_held: number;
  source_count: number;
};

export type UnmatchedReason = { reason: string; rows_waiting: number; revenue_held: number | null };

export type UnmatchedRow = {
  row_id: string;
  source: string;
  reason: string | null;
  best_guess: string | null;
  guess_method: string | null;
  confidence: string | null;
  revenue_held: number | null;
  raw_data: Record<string, unknown> | null;
};

/**
 * Everything the dashboard needs for one client, in one round-trip set.
 *
 * `error` is carried rather than thrown: before the migration has been applied
 * the views don't exist yet, and the page should say so plainly instead of
 * showing a 500.
 */
export type Dashboard = {
  clients: Client[];
  stages: Stage[];
  strip: StripCard[];
  total: Cut | null;
  baseline: Cut | null;
  byRound: Cut[];
  byAdset: Cut[];
  bySource: Cut[];
  imports: ImportStatus[];
  unmatched: UnmatchedSummary | null;
  unmatchedReasons: UnmatchedReason[];
  unmatchedRows: UnmatchedRow[];
  /** The tab actually rendered — may differ from the one asked for, see resolveView. */
  view: string;
  error: string | null;
};

const EMPTY: Omit<Dashboard, "error" | "view"> = {
  clients: [], stages: [], strip: [], total: null, baseline: null,
  byRound: [], byAdset: [], bySource: [], imports: [], unmatched: null,
  unmatchedReasons: [], unmatchedRows: [],
};

/** Which tabs actually read a metrics table. Everything else is chrome-only. */
const NEEDS_ROUNDS = new Set(["round"]);
const NEEDS_ADSETS = new Set(["targeting"]);
const NEEDS_SOURCES = new Set(["source"]);
const NEEDS_UNMATCHED_DETAIL = new Set(["unmatched"]);

/** The cut a tab reads, or null if it reads none. */
const cutFor = (view: string): Cut2 | null =>
  NEEDS_ROUNDS.has(view) ? "round"
  : NEEDS_ADSETS.has(view) ? "adset"
  : NEEDS_SOURCES.has(view) ? "source"
  : null;

type Cut2 = "round" | "adset" | "source";

/** Tabs that belong to a journey stage, so they only exist for some clients. */
const STAGE_TABS = ["targeting", "ads", "lp", "class", "preview", "middle", "product", "checkout"];

/**
 * Switching client keeps the tab only if the new client's journey has it —
 * Northsea has no class, so "Attend class" must not survive the switch.
 */
function resolveView(requested: string, slugs: Set<string>) {
  return slugs.has(requested) || !STAGE_TABS.includes(requested) ? requested : "round";
}

/**
 * The client list, with the default-client ordering already applied.
 *
 * Ordering by round count needs a count, and counting used to mean pulling every
 * rounds row on every page load — a whole table across the wire to produce one
 * integer per client. `head: true` with an exact count asks Postgres for the
 * number and returns no rows at all.
 *
 * Cached hard: clients change when DriveFunnels signs one, not when data lands.
 */
const loadClients = unstable_cache(
  async () => {
    const db = createReadClient();
    const { data, error } = await db
      .from("v_clients")
      .select("client_id, client_name, client_note, stage_count");

    if (error) return { clients: null, error };
    if (!data?.length) return { clients: [] as Client[], error: null };

    const counts = await Promise.all(
      data.map(async (c) => {
        const { count } = await db
          .from("rounds")
          .select("round_id", { count: "exact", head: true })
          .eq("client_id", c.client_id);
        return [c.client_id, count ?? 0] as const;
      }),
    );
    const byId = new Map(counts);

    // Open on the account with the most history rather than whichever name sorts
    // first, so the app lands on something worth looking at.
    const clients = [...data].sort(
      (a, b) =>
        (byId.get(b.client_id) ?? 0) - (byId.get(a.client_id) ?? 0) ||
        a.client_id.localeCompare(b.client_id),
    );
    return { clients, error: null };
  },
  ["funnel-clients"],
  { tags: [FUNNEL_TAG], revalidate: 3600 },
);

/** Nav, header and journey strip — needed whatever tab is open. */
const loadChrome = unstable_cache(
  async (id: string) => {
    const db = createReadClient();
    const [stages, strip, imports, unmatched] = await Promise.all([
      db.from("v_journey").select("*").eq("client_id", id).order("stage_order"),
      db.from("v_journey_strip").select("*").eq("client_id", id).order("stage_order"),
      db.from("v_import_status").select("*").eq("client_id", id),
      db.from("v_unmatched_summary").select("*").eq("client_id", id).maybeSingle(),
    ]);
    return {
      stages: stages.data ?? [],
      strip: strip.data ?? [],
      imports: imports.data ?? [],
      unmatched: unmatched.data ?? null,
    };
  },
  ["funnel-chrome"],
  { tags: [FUNNEL_TAG], revalidate: 300 },
);

/**
 * The spine columns for one comparison tab.
 *
 * Only the open tab's cut is fetched. The Import tab used to pull every round
 * and every ad set to render four dropzones that display neither.
 */
const loadMetrics = unstable_cache(
  async (id: string, cut: Cut2) => {
    const db = createReadClient();
    // Order explicitly: PostgREST doesn't guarantee a view's own ORDER BY survives.
    // Rounds read left-to-right in time; audiences by spend, biggest bet first;
    // sources in a fixed order, so a column doesn't slide sideways as rows land.
    const cuts =
      cut === "round"
        ? db.from("v_metrics_by_round")
            .select("cut_key, cut_label, cut_sub, m, start_date")
            .eq("client_id", id).order("start_date")
        : cut === "source"
        ? db.from("v_metrics_by_source")
            .select("cut_key, cut_label, cut_sub, m, ord")
            .eq("client_id", id).order("ord")
        : db.from("v_metrics_by_adset")
            .select("cut_key, cut_label, cut_sub, m, sort_spend")
            .eq("client_id", id).order("sort_spend", { ascending: false });

    const [total, baseline, columns] = await Promise.all([
      db.from("v_metrics_total").select("cut_key, cut_label, cut_sub, m").eq("client_id", id).maybeSingle(),
      db.from("v_metrics_baseline").select("cut_key, cut_label, cut_sub, m").eq("client_id", id).maybeSingle(),
      cuts,
    ]);
    return { total: total.data ?? null, baseline: baseline.data ?? null, columns: columns.data ?? [] };
  },
  ["funnel-metrics"],
  { tags: [FUNNEL_TAG], revalidate: 300 },
);

/** The parked queue, only for the tab that shows it. */
const loadUnmatchedDetail = unstable_cache(
  async (id: string) => {
    const db = createReadClient();
    const [reasons, rows] = await Promise.all([
      db.from("v_unmatched_by_reason").select("reason, rows_waiting, revenue_held").eq("client_id", id),
      db.from("unmatched_rows")
        .select("row_id, source, reason, best_guess, guess_method, confidence, revenue_held, raw_data")
        .eq("client_id", id)
        .eq("auto_resolved", false)
        .is("resolved_at", null)
        .order("revenue_held", { ascending: false })
        .limit(12),
    ]);
    return { reasons: reasons.data ?? [], rows: rows.data ?? [] };
  },
  ["funnel-unmatched"],
  { tags: [FUNNEL_TAG], revalidate: 60 },
);

export async function getDashboard(clientId?: string, requested = "round"): Promise<Dashboard> {
  const { clients, error: clientErr } = await loadClients();

  if (clientErr) {
    return {
      ...EMPTY,
      view: requested,
      error:
        clientErr.message.includes("does not exist") || clientErr.code === "42P01"
          ? "The database isn't set up yet — run supabase/migrations/ALL.sql in the Supabase SQL editor."
          : clientErr.message,
    };
  }
  if (!clients?.length) {
    return {
      ...EMPTY,
      view: requested,
      error: "No clients configured. Run supabase/migrations/ALL.sql to load the schema and seed.",
    };
  }

  const client = clients.find((c) => c.client_id === clientId) ?? clients[0];
  const id = client.client_id;

  // Chrome and the requested tab's data go out together — one wave, not three.
  // The tab is fetched speculatively: confirming it's valid for this client needs
  // the journey stages, and waiting for those would put the waterfall back.
  const wanted = cutFor(requested);
  const [chrome, speculative, detail] = await Promise.all([
    loadChrome(id),
    wanted ? loadMetrics(id, wanted) : null,
    NEEDS_UNMATCHED_DETAIL.has(requested) ? loadUnmatchedDetail(id) : null,
  ]);

  const view = resolveView(requested, new Set(chrome.stages.map((s) => s.stage_slug)));

  // Only when the guess was wrong — switching to a client whose journey lacks the
  // open tab — does a second fetch happen, and it's usually a cache hit.
  const settled = cutFor(view);
  const metrics =
    view === requested ? speculative : settled ? await loadMetrics(id, settled) : null;

  return {
    clients,
    stages: chrome.stages,
    strip: chrome.strip,
    imports: chrome.imports,
    unmatched: chrome.unmatched,
    total: metrics?.total ?? null,
    baseline: metrics?.baseline ?? null,
    byRound: NEEDS_ROUNDS.has(view) ? (metrics?.columns ?? []) : [],
    byAdset: NEEDS_ADSETS.has(view) ? (metrics?.columns ?? []) : [],
    bySource: NEEDS_SOURCES.has(view) ? (metrics?.columns ?? []) : [],
    unmatchedReasons: detail?.reasons ?? [],
    unmatchedRows: detail?.rows ?? [],
    view,
    error: null,
  };
}
