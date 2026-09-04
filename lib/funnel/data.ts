import { unstable_cache } from "next/cache";
import { createReadClient, FUNNEL_TAG } from "@/lib/supabase/read";
import { cadencesFor, resolveSpine, type Cadence } from "./cadence";
import {
  cutFor, NEEDS_MONTHS, NEEDS_WEEKS, NEEDS_ROUNDS, NEEDS_ADSETS, NEEDS_SOURCES,
  NEEDS_ROUND_SOURCE, NEEDS_ADS, NEEDS_SESSION, NEEDS_OFFER, NEEDS_THIS_ROUND,
  NEEDS_UNMATCHED_DETAIL, NEEDS_VARIANT, narrowToAsset, type Cut2,
} from "./cuts";
import type { Metrics } from "./spine";
import type { ScrollRun } from "./scroll";

export type { Cadence };

export type Client = {
  client_id: string;
  client_name: string | null;
  client_note: string | null;
  stage_count: number;
  /**
   * A fixture account, not a business. Null on a database that has not run
   * 0042 — read as false, because an unflagged client is a real one.
   */
  is_demo?: boolean | null;
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

/**
 * One journey card. `m` is the whole metric object, so the card is derived from
 * exactly the same numbers — and the same channel blanking — as every table.
 * `value`/`rate` are the view's older flat columns and are not read.
 */
export type StripCard = Stage & {
  value: string | null;
  rate: string | null;
  m?: Metrics | null;
};

export type Cut = {
  cut_key: string;
  cut_label: string;
  cut_sub: string | null;
  m: Metrics;
  /**
   * Set only by cross-tab cuts. Adjacent columns sharing a group_key are
   * spanned by one header cell above them — rounds across the top, sources
   * underneath. Absent on every one-dimensional cut, which is why the second
   * header row only appears when there's something to put in it.
   */
  group_key?: string | null;
  group_label?: string | null;
  group_sub?: string | null;
};

export type ImportStatus = {
  client_id: string | null;
  source: string;
  imported_at: string;
  coverage_start: string | null;
  coverage_end: string | null;
  row_count: number | null;
  is_stale: boolean;
  /** Days since the file was imported. A fact about the clock; claims nothing. */
  days_since: number;
  /** Days of finished rounds this source says nothing about. Null when none. */
  days_behind: number | null;
};

export type UnmatchedSummary = {
  waiting: number;
  auto_resolved: number;
  revenue_held: number;
  sales_held: number;
  source_count: number;
};

/** One audience or creative inside one round — step 3's raw material. */
export type RoundAsset = {
  round_id: string;
  kind: "audience" | "creative";
  name: string;
  spend: number | null;
  leads: number;
  spend_share: number | null;
  /**
   * What the asset produced past the opt-in — appended by 0033. Optional
   * because a database that has not run it returns the row without them, and
   * step 7 has to say "not measured" rather than read the absence as nought.
   */
  att?: number | null;
  prev_buys?: number | null;
  rev?: number | null;
};

/**
 * Everything "This round" needs beyond the two round columns it already gets.
 * Loaded only for that tab — no other screen asks any of these questions.
 */
export type RoundContext = {
  /** The month the round sits in, and the one before it. Step 1. */
  months: Cut[];
  /** Assets in this round and in the previous one. Step 3. */
  assets: RoundAsset[];
  /** Agreed numbers, by spine metric key. Empty until someone sets one. */
  targets: Record<string, number>;
  /**
   * Landing-page scroll curves for these two rounds. Step 3c — empty until a
   * Clarity export covering one of them has been imported.
   */
  scroll: ScrollRun[];
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
 * What the filter bar is currently set to. Null on any field means "not
 * filtering on this" — the same thing the database means by an unset setting,
 * so there is one idea of "off" rather than two.
 */
export type FilterKey = {
  product: string | null;
  channel: string | null;
  from: string | null;
  to: string | null;
  /**
   * ONE ASSET, AND THEN THE ROUNDS ARE THE COLUMNS.
   *
   * Not a filter in the fo_cut sense — it never reaches the database settings.
   * It turns the asset tabs from "every asset, summed over its rounds" into
   * "this asset, round by round", which is the same tab answering the second
   * half of the same question: the flat view says which creative is best, this
   * says whether that has been true all along.
   *
   * Frequency is why it exists. An audience that has seen a creative eleven
   * times is not the audience that saw it twice, and no amount of summing the
   * rounds together will show the moment it stopped working.
   */
  asset: string | null;
};

export const NO_FILTER: FilterKey = { product: null, channel: null, from: null, to: null, asset: null };

export type Product = {
  product_id: string;
  client_id: string;
  product_name: string;
  product_note: string | null;
  round_count: number;
  cadence: Cadence;
};

/** A period the client actually has data for. Never an empty window. */
export type Period = { key: string; label: string; from: string | null; to: string | null };

export type ChannelOption = {
  client_id: string;
  channel: string;
  note: string | null;
  ad_rows: number;
  spend: number | null;
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
  byMonth: Cut[];
  byWeek: Cut[];
  byRound: Cut[];
  byAd: Cut[];
  bySession: Cut[];
  byOffer: Cut[];
  thisRound: Cut[];
  byAdset: Cut[];
  bySource: Cut[];
  byRoundSource: Cut[];
  byVariant: Cut[];
  /**
   * The open tab's columns, whichever cut it reads. The per-cut arrays above
   * exist so each pane can name the one it means; this is the same list under a
   * name that doesn't, for the graph — which draws whatever the tab is showing
   * and has no reason to know which tab that is.
   */
  columns: Cut[];
  /** Only on This round — the extra context the CRO steps need. */
  roundContext: RoundContext | null;
  imports: ImportStatus[];
  unmatched: UnmatchedSummary | null;
  unmatchedReasons: UnmatchedReason[];
  unmatchedRows: UnmatchedRow[];
  /** What the filter bar can offer, and what it is currently set to. */
  products: Product[];
  channels: ChannelOption[];
  periods: Period[];
  filter: FilterKey;
  /**
   * The cadences in play under the current filter — which of By round and By
   * week the sidebar should offer. Both, when the filter spans products that
   * run differently, because at that point both are true at once.
   */
  cadences: Cadence[];
  /** The tab actually rendered — may differ from the one asked for, see resolveView. */
  view: string;
  error: string | null;
  /** What to actually do about `error`. Null when there is nothing to fix. */
  errorHint: string | null;
};

const EMPTY: Omit<Dashboard, "error" | "errorHint" | "view"> = {
  clients: [], stages: [], strip: [], total: null, baseline: null,
  products: [], channels: [], periods: [], filter: NO_FILTER, cadences: ["round"],
  byMonth: [], byWeek: [], byRound: [], byAdset: [], bySource: [], byRoundSource: [], byVariant: [],
  byAd: [], bySession: [], byOffer: [], thisRound: [],
  columns: [], roundContext: null,
  imports: [], unmatched: null,
  unmatchedReasons: [], unmatchedRows: [],
};

/** Which tabs actually read a metrics table. Everything else is chrome-only. */

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
/**
 * A failed read must never be cached.
 *
 * `unstable_cache` stores whatever the function returns, and every loader here
 * used to fold a failure into `?? []` or an error object and return it. A
 * one-second network blip therefore became an hour of a wrong screen: Supabase
 * recovered within seconds and the app kept serving the frozen failure, past a
 * redeploy, because the Data Cache outlives deployments. Nothing on the page
 * said so — an empty dashboard from a dropped connection is indistinguishable
 * from an empty dashboard from an empty database.
 *
 * Throwing instead is what makes it self-healing: `unstable_cache` caches a
 * returned value and never a thrown one, so the very next request retries.
 */
function ok<R extends { data: unknown; error: { message: string; code?: string } | null }>(
  r: R,
  what: string,
): R["data"] {
  if (r.error) throw Object.assign(new Error(`${what}: ${r.error.message}`), { code: r.error.code });
  return r.data;
}

const loadClients = unstable_cache(
  async () => {
    const db = createReadClient();
    const data = ok(
      await db.from("v_clients").select("client_id, client_name, client_note, stage_count, is_demo"),
      "v_clients",
    );

    if (!data?.length) return [] as Client[];

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

    /**
     * Real accounts first, then the one with the most history.
     *
     * "Most history" alone was the rule, and it stopped working the moment a
     * fixture account held more rounds than a real one: Northsea Supply carries
     * the four imaginary weekly rounds and Shely has two real ones, so the app
     * opened on the demo client and showed 40,000 invented impressions as the
     * first thing anyone saw.
     *
     * 0042 also orders v_clients this way, and that ordering is not what decides
     * it — this sort is. The view is ordered too so that anything reading it
     * directly gets the same answer, but the app has always re-sorted here and
     * fixing only the SQL fixed nothing.
     */
    return [...data].sort(
      (a, b) =>
        Number(a.is_demo ?? false) - Number(b.is_demo ?? false) ||
        (byId.get(b.client_id) ?? 0) - (byId.get(a.client_id) ?? 0) ||
        a.client_id.localeCompare(b.client_id),
    );
  },
  ["funnel-clients"],
  { tags: [FUNNEL_TAG], revalidate: 3600 },
);

/** Nav, header and journey strip — needed whatever tab is open. */
const loadChrome = unstable_cache(
  async (id: string) => {
    const db = createReadClient();
    const [stages, imports, unmatched] = await Promise.all([
      db.from("v_journey").select("*").eq("client_id", id).order("stage_order"),
      db.from("v_import_status").select("*").eq("client_id", id),
      db.from("v_unmatched_summary").select("*").eq("client_id", id).maybeSingle(),
    ]);
    return {
      stages: ok(stages, "v_journey") ?? [],
      imports: ok(imports, "v_import_status") ?? [],
      unmatched: ok(unmatched, "v_unmatched_summary") ?? null,
    };
  },
  ["funnel-chrome"],
  { tags: [FUNNEL_TAG], revalidate: 300 },
);

/**
 * The journey strip, under the active filter.
 *
 * Separate from loadChrome and read through fo_cut, because it is the only part
 * of the chrome that is made of NUMBERS. It used to be fetched straight from
 * PostgREST alongside the stages and the import status, which meant the filter
 * was never set for it and the strip showed 393 leads above a table showing 313.
 * The journey config genuinely doesn't move when you filter; the figures on it
 * do.
 */
const loadStrip = unstable_cache(
  async (id: string, f: FilterKey) => {
    const db = createReadClient();
    const strip = await db.rpc("fo_cut", {
      p_view: "v_journey_strip",
      p_client: id, p_product: f.product, p_channel: f.channel, p_from: f.from, p_to: f.to,
    });
    return (ok(strip, "v_journey_strip") as StripCard[] | null) ?? [];
  },
  ["funnel-strip"],
  { tags: [FUNNEL_TAG], revalidate: 300 },
);

/**
 * The spine columns for one comparison tab.
 *
 * Only the open tab's cut is fetched. The Import tab used to pull every round
 * and every ad set to render four dropzones that display neither.
 */
/**
 * The spine columns for one comparison tab, under the active filter.
 *
 * Reads go through fo_cut() rather than the views directly. A filter has to
 * bite BEFORE the rows are added up — you cannot average a ROAS back out of a
 * total — and a view takes no arguments, so fo_cut sets the filter and reads
 * the cut inside one transaction. It returns each row as jsonb, which is why a
 * single call serves eleven cuts of different shapes, and why the ordering is
 * applied in the database instead of here.
 *
 * Only the open tab's cut is fetched. The Import tab used to pull every round
 * and every ad set to render four dropzones that display neither.
 */
const VIEW_FOR: Record<Cut2, string> = {
  month:       "v_metrics_by_month",
  week:        "v_metrics_by_week",
  round:       "v_metrics_by_round",
  roundsource: "v_metrics_by_round_source",
  source:      "v_metrics_by_source",
  ad:          "v_metrics_by_ad",
  session:     "v_metrics_by_session",
  preview:     "v_metrics_by_offer",
  middle:      "v_metrics_by_offer",
  thisround:   "v_metrics_this_round",
  adset:       "v_metrics_by_adset",
  adround:     "v_metrics_by_ad_round",
  adsetround:  "v_metrics_by_adset_round",
  variant:     "v_metrics_by_variant",
  variantround:"v_metrics_by_variant_round",
};

const loadMetrics = unstable_cache(
  async (id: string, cut: Cut2, f: FilterKey) => {
    const db = createReadClient();
    const scope = { p_client: id, p_product: f.product, p_channel: f.channel, p_from: f.from, p_to: f.to };

    const [total, baseline, columns] = await Promise.all([
      db.rpc("fo_cut", { p_view: "v_metrics_total", ...scope }),
      db.rpc("fo_cut", { p_view: "v_metrics_baseline", ...scope }),
      db.rpc("fo_cut", {
        p_view: VIEW_FOR[cut],
        ...scope,
        // the two offer tabs are one view told apart by a product filter
        p_offer: cut === "preview" || cut === "middle" ? cut : null,
      }),
    ]);
    return {
      total: (ok(total, "v_metrics_total") as Cut[] | null)?.[0] ?? null,
      baseline: (ok(baseline, "v_metrics_baseline") as Cut[] | null)?.[0] ?? null,
      columns: (ok(columns, `metrics:${cut}`) as Cut[] | null) ?? [],
    };
  },
  ["funnel-metrics"],
  { tags: [FUNNEL_TAG], revalidate: 300 },
);

/**
 * What the filter bar can offer this client.
 *
 * Deliberately NOT filtered itself — the list of products has to stay whole
 * while you are standing on one of them, or choosing a product would remove
 * every other option and you could never choose back.
 */
const loadFilterOptions = unstable_cache(
  async (id: string) => {
    const db = createReadClient();
    const [products, channels, rounds] = await Promise.all([
      db.from("v_products").select("*").eq("client_id", id).order("ord"),
      db.from("v_client_channels").select("*").eq("client_id", id).order("ord"),
      db.from("rounds").select("round_id, start_date, end_date").eq("client_id", id).order("start_date"),
    ]);
    const rs = (ok(rounds, "rounds") as { round_id: string; start_date: string; end_date: string }[] | null) ?? [];

    /**
     * Only periods that exist. A month with no round is not offered, because
     * choosing it would produce a screen of dashes and no way to tell that from
     * a broken filter. Months first, then the rounds inside them.
     */
    const months = new Map<string, { from: string; to: string }>();
    for (const r of rs) {
      const k = r.start_date.slice(0, 7);
      const m = months.get(k);
      months.set(k, {
        from: m && m.from < r.start_date ? m.from : r.start_date,
        to: m && m.to > r.end_date ? m.to : r.end_date,
      });
    }
    const monthLabel = (k: string) =>
      new Date(`${k}-01T00:00:00Z`).toLocaleDateString("en-SG", {
        month: "long", year: "numeric", timeZone: "UTC",
      });
    const dayLabel = (d: string) =>
      new Date(`${d}T00:00:00Z`).toLocaleDateString("en-SG", {
        day: "numeric", month: "short", timeZone: "UTC",
      });

    const periods: Period[] = [
      ...[...months].map(([k, v]) => ({ key: `m:${k}`, label: monthLabel(k), from: v.from, to: v.to })),
      ...rs.map((r) => ({
        key: `r:${r.round_id}`,
        label: `${r.round_id} · ${dayLabel(r.start_date)}–${dayLabel(r.end_date)}`,
        from: r.start_date,
        to: r.end_date,
      })),
    ];

    return {
      products: (ok(products, "v_products") as Product[] | null) ?? [],
      channels: (ok(channels, "v_client_channels") as ChannelOption[] | null) ?? [],
      periods,
    };
  },
  ["funnel-filter-options"],
  { tags: [FUNNEL_TAG], revalidate: 3600 },
);

/**
 * The rest of what "This round" needs: the month it sits in, what carried money
 * in it and in the round before, and any agreed targets.
 *
 * Assets are NOT filtered through fo_cut. They are read for two named rounds,
 * and the product/period filter has already decided which two those are — a
 * second filter would only ever remove one of the pair and leave the screen
 * comparing a round against nothing.
 */
const loadRoundContext = unstable_cache(
  async (id: string, f: FilterKey): Promise<RoundContext> => {
    const db = createReadClient();
    const scope = { p_client: id, p_product: f.product, p_channel: f.channel, p_from: f.from, p_to: f.to };

    const [rounds, months, targets] = await Promise.all([
      db.rpc("fo_cut", { p_view: "v_metrics_this_round", ...scope }),
      db.rpc("fo_cut", { p_view: "v_metrics_by_month", ...scope }),
      db.from("v_client_targets").select("metric, target").eq("client_id", id),
    ]);

    const twoRounds = (ok(rounds, "v_metrics_this_round") as Cut[] | null) ?? [];
    const ids = twoRounds.map((r) => r.cut_key);

    /**
     * Assets and scroll curves are read for the two named rounds, not through
     * fo_cut. The product/period filter has already decided which two those
     * are; a second filter could only ever remove one of the pair and leave the
     * screen comparing a round against nothing.
     *
     * Scroll is not channel-filtered either, and deliberately: a page has one
     * scroll curve regardless of which platform paid for the visit, and Clarity
     * cannot tell them apart. Blanking it under a channel filter would suggest
     * the filter had removed something it never held.
     */
    const [assetRows, scrollRows] = ids.length
      ? await Promise.all([
          db.from("v_round_assets")
            .select("round_id, kind, name, spend, leads, spend_share, att, prev_buys, rev")
            .eq("client_id", id)
            .in("round_id", ids),
          db.from("v_scroll_runs")
            .select("run_id, round_id, page_label, device, sessions, page_views, captured_from, captured_to, points")
            .eq("client_id", id)
            .in("round_id", ids),
        ])
      : [null, null];

    const rows = (ok(targets, "v_client_targets") as { metric: string; target: string | number }[] | null) ?? [];
    return {
      // the two most recent months, newest last, same order as the cut
      months: ((ok(months, "v_metrics_by_month") as Cut[] | null) ?? []).slice(-2),
      assets: (assetRows ? (ok(assetRows, "v_round_assets") as RoundAsset[] | null) : null) ?? [],
      targets: Object.fromEntries(rows.map((r) => [r.metric, Number(r.target)])),
      scroll: (scrollRows ? (ok(scrollRows, "v_scroll_runs") as ScrollRun[] | null) : null) ?? [],
    };
  },
  ["funnel-round-context"],
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
    return {
      reasons: ok(reasons, "v_unmatched_by_reason") ?? [],
      rows: ok(rows, "unmatched_rows") ?? [],
    };
  },
  ["funnel-unmatched"],
  { tags: [FUNNEL_TAG], revalidate: 60 },
);

/**
 * Three failures that arrive as the same exception and have nothing in common
 * as problems. Sending all of them to the SQL editor is wrong twice out of
 * three times, and it wastes the reader's first guess — the one that costs the
 * most, because they act on it before doubting it.
 */
function explain(e: unknown, requested: string): Dashboard {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code;
  // PostgREST reports a missing FUNCTION as PGRST202 with "Could not find the
  // function", not "does not exist" — so a database that has the views but not
  // yet 0023 used to land on the raw message with no hint at all.
  const missing =
    msg.includes("does not exist") || code === "42P01" ||
    code === "PGRST202" || msg.includes("Could not find the function");
  const unreachable = msg.includes("Could not reach");
  return {
    ...EMPTY,
    view: requested,
    error: missing ? "The database isn't set up yet." : msg,
    errorHint: missing
      ? "Run supabase/migrations/ALL.sql in the Supabase SQL editor — that's the 7-table schema, the seed and the metric views, in order."
      : unreachable
        ? "The schema is not the problem — nothing here even got as far as a query. Check that the Supabase project is running and not paused, that NEXT_PUBLIC_SUPABASE_URL is right, and that Network Restrictions aren't blocking the host doing the asking. Nothing is cached, so reloading is the retry."
        : null,
  };
}

export async function getDashboard(
  clientId?: string,
  requested = "round",
  filter: FilterKey = NO_FILTER,
): Promise<Dashboard> {
  try {
    return await build(clientId, requested, filter);
  } catch (e) {
    return explain(e, requested);
  }
}

async function build(
  clientId: string | undefined,
  requested: string,
  filter: FilterKey,
): Promise<Dashboard> {
  const clients = await loadClients();

  if (!clients.length) {
    return {
      ...EMPTY,
      view: requested,
      error: "No clients configured.",
      errorHint: "Run supabase/migrations/ALL.sql to load the schema and seed.",
    };
  }

  const client = clients.find((c) => c.client_id === clientId) ?? clients[0];
  const id = client.client_id;

  // Chrome and the requested tab's data go out together — one wave, not three.
  // The tab is fetched speculatively: confirming it's valid for this client needs
  // the journey stages, and waiting for those would put the waterfall back.
  const wanted = cutFor(requested, filter.asset);
  const [chrome, strip, options, speculative, detail] = await Promise.all([
    loadChrome(id),
    loadStrip(id, filter),
    loadFilterOptions(id),
    wanted ? loadMetrics(id, wanted, filter) : null,
    NEEDS_UNMATCHED_DETAIL.has(requested) ? loadUnmatchedDetail(id) : null,
  ]);

  // Only This round asks these questions, so only This round pays for them.
  const context = NEEDS_THIS_ROUND.has(requested) ? await loadRoundContext(id, filter) : null;

  const cadences = cadencesFor(options.products, filter.product);
  const view = resolveSpine(
    resolveView(requested, new Set(chrome.stages.map((s) => s.stage_slug))),
    cadences,
  );

  // Only when the guess was wrong — switching to a client whose journey lacks the
  // open tab — does a second fetch happen, and it's usually a cache hit.
  const settled = cutFor(view, filter.asset);
  const metrics =
    view === requested ? speculative : settled ? await loadMetrics(id, settled, filter) : null;

  /**
   * The columns every part of this screen shows.
   *
   * Drilled into an asset, only that asset's rounds are wanted — and only the
   * two asset tabs have an asset at all, so nothing else can be narrowed by a
   * stray ?asset= in the URL. group_key rather than the label, because the
   * label is prettified and "(unsplit)" is not "Unsplit spend".
   */
  const shown = narrowToAsset(metrics?.columns ?? [], view, filter.asset);

  return {
    clients,
    products: options.products,
    channels: options.channels,
    periods: options.periods,
    filter,
    cadences,
    stages: chrome.stages,
    strip,
    imports: chrome.imports,
    unmatched: chrome.unmatched,
    total: metrics?.total ?? null,
    baseline: metrics?.baseline ?? null,
    byMonth: NEEDS_MONTHS.has(view) ? shown : [],
    byWeek: NEEDS_WEEKS.has(view) ? shown : [],
    byAd: NEEDS_ADS.has(view) ? shown : [],
    bySession: NEEDS_SESSION.has(view) ? shown : [],
    byOffer: NEEDS_OFFER.has(view) ? shown : [],
    thisRound: NEEDS_THIS_ROUND.has(view) ? shown : [],
    byRound: NEEDS_ROUNDS.has(view) ? shown : [],
    // Drilled in, the columns are one asset's rounds; the tab renders the same
    // table and the same plot, so the narrowing happens here rather than there.
    byAdset: NEEDS_ADSETS.has(view) ? shown : [],
    bySource: NEEDS_SOURCES.has(view) ? shown : [],
    byRoundSource: NEEDS_ROUND_SOURCE.has(view) ? shown : [],
    byVariant: NEEDS_VARIANT.has(view) ? shown : [],
    // One slot for both, because the tab already says which asset it is about
    // and the shape is identical either way.
    // The GRAPH reads this and the tables read the lists above. They were two
    // derivations of the same thing and only one was narrowed, so a drilled-in
    // table showed one asset while the plot beside it drew all of them. One
    // list, computed once, used by both.
    columns: shown,
    roundContext: context,
    unmatchedReasons: detail?.reasons ?? [],
    unmatchedRows: detail?.rows ?? [],
    view,
    error: null,
    errorHint: null,
  };
}
