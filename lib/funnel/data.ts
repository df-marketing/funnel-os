import { isReportingPreviewClient, isReportingPreviewView } from "./reporting-preview";
import { previewCadencesFor } from "./preview-periods";
import { buildJourneyStrip, type JourneyVocabulary } from "./journey-strip";
import { keepsSpend } from "./filters";
import { comparisonStage, isComparisonAddress, isFixedReportingView, stageComparison, type StageComparison } from "./stage-comparison";
import { unstable_cache } from "next/cache";
import { createReadClient, FUNNEL_TAG } from "@/lib/supabase/read";
import { cadencesFor, resolveSpine, type Cadence } from "./cadence";
import {
  cutFor, NEEDS_MONTHS, NEEDS_WEEKS, NEEDS_ROUNDS, NEEDS_ADSETS, NEEDS_SOURCES,
  NEEDS_ROUND_SOURCE, NEEDS_ADS, NEEDS_SESSION, NEEDS_OFFER, NEEDS_THIS_ROUND,
  NEEDS_UNMATCHED_DETAIL, NEEDS_VARIANT, NEEDS_LANDING, narrowToAsset, monthOf,
  anchorOf, monthWindow,
  type Cut2,
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
  /** ISO 4217. Not a union of the currencies we already have — see the note on
      FunnelSchema.currency; that shape refused a client billing in USD. */
  currency?: string | null;
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

/** One card based on a scoped stage and filter-aware reporting totals. */
export type StripCard = Stage & { value: number | null; rate: number | null };

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

/** One reported value from a lead-form field, retained at import time. */
export type FormAnswer = { question: string; answer: string; leads: number };

/**
 * What the filter bar is currently set to. Null on any field means "not
 * filtering on this" — the same thing the database means by an unset setting,
 * so there is one idea of "off" rather than two.
 */
export type FilterKey = {
  /**
   * EVERY FIELD IS A SET, carried as one comma-separated string — the same
   * string the URL holds and fo_cut receives. See lib/funnel/filters.ts for
   * the toggle/has/listOf helpers. A single value is a one-element set.
   */
  product: string | null;
  channel: string | null;
  country: string | null;
  /**
   * One attribution bucket — Paid Ads, Organic, AOAI… — or all of them.
   *
   * A fact about the PERSON, so it narrows leads, attendance and sales and
   * leaves spend alone: spend has no source, it is all paid. Under anything
   * but Paid Ads the database blanks spend and every rate built on it (0067),
   * because organic leads divided by paid spend is not a cost per lead.
   */
  source: string | null;
  /** A set of ad-set names that follows the reader across every tab. */
  audience: string | null;
  /** The one credit rule used by every report on this screen. */
  attribution: "entry" | "entry_paid" | "last_touch" | "last_paid" | "even_split";
  /**
   * The chosen periods, as their own dates: "2026-05-13..2026-05-28,2026-07-01..2026-07-30".
   * A set like the four above, so May and July can be read without June. The
   * database tests each round for overlap with ANY member. Null is all time.
   */
  periods: string | null;
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

export const NO_FILTER: FilterKey = {
  product: null, channel: null, country: null, source: null, audience: null,
  attribution: "entry", periods: null, asset: null,
};

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

/** Countries stated on this client's rounds. A null country is deliberately not an option. */
export type CountryOption = { country: string; round_count: number };

/** Attribution buckets this client has people in, in the source view's order. */
export type AudienceOption = { audience: string; leads: number };
export type SourceOption = { bucket: string; ord: number; note: string | null; leads: number };

/**
 * Everything the dashboard needs for one client, in one round-trip set.
 *
 * `error` is carried rather than thrown: before the migration has been applied
 * the views don't exist yet, and the page should say so plainly instead of
 * showing a 500.
 */
type RoundSchedule = { round_id: string; code: string | null; start_date: string; end_date: string };

export type Dashboard = {
  reportingPreview?: {
    vocabulary: JourneyVocabulary | null;
    analysis?: {
      stages: Stage[];
      vocabulary: JourneyVocabulary | null;
      roundCuts: Cut[];
      monthCuts: Cut[];
      roundSchedule: RoundSchedule[];
      sourceKeepsSpend: boolean;
      baseline: Cut | null;
    };
  };
  clients: Client[];
  stages: Stage[];
  comparison: StageComparison | null;
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
  byLanding: Cut[];
  /**
   * The open tab's columns, whichever cut it reads. The per-cut arrays above
   * exist so each pane can name the one it means; this is the same list under a
   * name that doesn't, for the graph — which draws whatever the tab is showing
   * and has no reason to know which tab that is.
   */
  columns: Cut[];
  /**
   * Rounds this comparison DOES have rows in, when the period filter is what
   * emptied it. Null means the cut is not empty, or is empty everywhere.
   */
  elsewhere: string[] | null;
  /** Only on This round — the extra context the CRO steps need. */
  roundContext: RoundContext | null;
  imports: ImportStatus[];
  unmatched: UnmatchedSummary | null;
  unmatchedReasons: UnmatchedReason[];
  unmatchedRows: UnmatchedRow[];
  formAnswers: FormAnswer[];
  /** What the filter bar can offer, and what it is currently set to. */
  products: Product[];
  channels: ChannelOption[];
  countries: CountryOption[];
  sources: SourceOption[];
  audiences: AudienceOption[];
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
  clients: [], stages: [], comparison: null, strip: [], total: null, baseline: null,
  products: [], channels: [], countries: [], sources: [], audiences: [], periods: [], filter: NO_FILTER, cadences: ["round"],
  byMonth: [], byWeek: [], byRound: [], byAdset: [], bySource: [], byRoundSource: [], byVariant: [], byLanding: [],
  byAd: [], bySession: [], byOffer: [], thisRound: [],
  columns: [], elsewhere: null, roundContext: null,
  imports: [], unmatched: null,
  unmatchedReasons: [], unmatchedRows: [],
  formAnswers: [],
};

/** Which tabs actually read a metrics table. Everything else is chrome-only. */

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
      await db.from("v_clients").select("client_id, client_name, client_note, stage_count, is_demo, currency"),
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
  /* One hour, up from five minutes. The nav shell and the client's stages only
     change when AcqOS pushes a funnel, and that path calls revalidateTag. Five
     minutes was re-reading a stage list that changes a few times a year. */
  { tags: [FUNNEL_TAG], revalidate: 3600 },
);

const reportingScope = (id: string, f: FilterKey) => ({
  p_client: id, p_product: f.product, p_channel: f.channel, p_country: f.country,
  p_source: f.source, p_audience: f.audience, p_attribution: f.attribution, p_periods: f.periods,
});

/** One filtered total for the reporting table and journey strip, not a second
 * per-stage SQL join. Refresh/import/schema events invalidate the same tag. */
const loadReportingTotal = unstable_cache(
  async (id: string, f: FilterKey) => {
    const db = createReadClient();
    const read = await db.rpc("fo_cut", { p_view: "v_metrics_total", ...reportingScope(id, f) });
    return (ok(read, "v_metrics_total") as Cut[] | null)?.[0] ?? null;
  },
  ["funnel-reporting-total"],
  { tags: [FUNNEL_TAG], revalidate: 64800 },
);

const loadJourneyVocabulary = unstable_cache(
  async (id: string): Promise<JourneyVocabulary> => {
    const db = createReadClient();
    const columns = "metric, metric_key, client_id, source, event_type, is_core";
    const maximum = 512;
    const [global, own] = await Promise.all([
      db.from("journey_metrics").select(columns).is("client_id", null).limit(maximum),
      db.from("journey_metrics").select(columns).eq("client_id", id).limit(maximum),
    ]);
    const globalRows = (ok(global, "global journey measurements") ?? []) as JourneyVocabulary;
    const clientRows = (ok(own, "client journey measurements") ?? []) as JourneyVocabulary;
    // Do not cache a partial vocabulary: an unseen conflicting definition
    // could otherwise make an overwritten key look safe.
    if (globalRows.length >= maximum || clientRows.length >= maximum) throw new Error("Journey vocabulary exceeds the safe limit.");
    return [...globalRows, ...clientRows];
  },
  ["funnel-journey-vocabulary"],
  { tags: [FUNNEL_TAG], revalidate: 3600 },
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
/**
 * The by-round twin of a flat cut, where one exists. Used only to answer "which
 * rounds did this run in" when a period filter has emptied the tab.
 */
const ROUND_COMPANION: Partial<Record<Cut2, string>> = {
  adset:   "v_metrics_by_adset_round",
  ad:      "v_metrics_by_ad_round",
  variant: "v_metrics_by_variant_round",
  landing: "v_metrics_by_lp_round",
};

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
  landing:     "v_metrics_by_lp",
  landinground:"v_metrics_by_lp_round",
};

const loadMetrics = unstable_cache(
  async (id: string, cut: Cut2, f: FilterKey) => {
    const db = createReadClient();
    const scope = reportingScope(id, f);

    const [baseline, columns] = await Promise.all([
      db.rpc("fo_cut", { p_view: "v_metrics_baseline", ...scope }),
      db.rpc("fo_cut", {
        p_view: VIEW_FOR[cut],
        ...scope,
        // the two offer tabs are one view told apart by a product filter
        p_offer: cut === "preview" || cut === "middle" ? cut : null,
      }),
    ]);
    const cols = (ok(columns, `metrics:${cut}`) as Cut[] | null) ?? [];

    /**
     * WHERE IT DOES EXIST.
     *
     * An empty cut said "no columns under the current filter", which is true and
     * useless — it does not say whether the comparison has no data at all or
     * simply none in the period you happen to be standing in. The A/B test ran in
     * four rounds of July and early August; on September the tab drew nothing and
     * looked broken.
     *
     * So when a cut comes back empty AND a period is narrowing it, ask the same
     * view again with the period dropped. If rows appear, the data exists and the
     * period is what removed it — and the rounds it ran in are worth naming,
     * because they are where the reader has to go.
     *
     * Only on an empty cut, so the common path costs nothing.
     */
    let elsewhere: string[] | null = null;
    if (!cols.length && f.periods) {
      const wide = { ...scope, p_periods: null };
      const companion = ROUND_COMPANION[cut];
      const probe = await db.rpc("fo_cut", {
        p_view: companion ?? VIEW_FOR[cut],
        ...wide,
        p_offer: cut === "preview" || cut === "middle" ? cut : null,
      });
      const rows = (probe.error ? null : (probe.data as Cut[] | null)) ?? [];
      if (rows.length) {
        // the companion cuts BY round, so its labels are the round ids
        elsewhere = companion
          ? [...new Set(rows.map((r) => r.cut_label).filter(Boolean) as string[])].sort()
          : [];
      }
    }

    return {
      baseline: (ok(baseline, "v_metrics_baseline") as Cut[] | null)?.[0] ?? null,
      columns: cols,
      elsewhere,
    };
  },
  ["funnel-metrics-without-total"],
  // Same window and the same reason as funnel-strip above. This is the one a
  // filter change actually re-reads, so it is the one the wait is felt on —
  // measured 21 Sep at 3.2s to 10.4s cold, and 0.044s warm. Which is the whole
  // argument for the longer window, and also the whole limit of it: it widens
  // the 0.044s case and does nothing whatever for the 10.4s one.
  { tags: [FUNNEL_TAG], revalidate: 64800 },
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
    const [products, channels, rounds, buckets, audiences, adCountries] = await Promise.all([
      db.from("v_products").select("*").eq("client_id", id).order("ord"),
      db.from("v_client_channels").select("*").eq("client_id", id).order("ord"),
      db.from("rounds").select("round_id, code, market, start_date, end_date, country").eq("client_id", id).order("start_date"),
      // The buckets this client has people in (0067). Tolerated when absent —
      // a database in front of that migration simply offers no source filter.
      db.from("v_client_sources").select("bucket, ord, note, leads").eq("client_id", id).order("ord"),
      db.from("v_client_audiences").select("audience, leads").eq("client_id", id)
        .order("leads", { ascending: false }).limit(30),
      // Counted in SQL (0063). Folding rows here missed MY entirely: PostgREST
      // caps a response at 1000 rows, v_ads has 1,832, and every MY row is in
      // the last round. A distinct that has to be complete cannot be built from
      // a page of rows.
      db.from("v_client_countries").select("country, round_count").eq("client_id", id).order("country"),
    ]);
    const rs = (ok(rounds, "rounds") as { round_id: string; code: string | null; market: string | null; start_date: string; end_date: string; country: string | null }[] | null) ?? [];
    /**
     * The countries this client actually ran in, counted over ROUNDS but
     * gathered from the ad rows.
     *
     * It used to read rounds.country alone, and a round that ran two countries
     * has none — so the client's own SG/MY round offered SG only, and choosing
     * it deleted that round, and September with it, from every screen. The ad
     * rows knew: DF_SG_ and DF_MY_ campaigns, side by side in the same round.
     */
    let countries = (adCountries.error ? null : (adCountries.data as CountryOption[] | null)) ?? [];
    if (adCountries.error) {
      /*
       * The view is from 0063 and this build may be in front of it. Page the ad
       * rows instead — slower, two or three round trips, but it cannot silently
       * return a short answer, which is the whole failure being fixed here.
       */
      const seen = new Map<string, Set<string>>();
      for (let from = 0; ; from += 1000) {
        const page = await db.from("v_ads").select("round_id, campaign")
          .eq("client_id", id).range(from, from + 999);
        const rows = (page.data as { round_id: string; campaign: string | null }[] | null) ?? [];
        for (const a of rows) {
          const c = /^DF_([A-Z]{2})_/.exec(String(a.campaign ?? "").toUpperCase())?.[1];
          if (c) (seen.get(c) ?? seen.set(c, new Set()).get(c)!).add(a.round_id);
        }
        if (rows.length < 1000) break;
      }
      for (const r of rs) if (r.country) {
        (seen.get(r.country) ?? seen.set(r.country, new Set()).get(r.country)!).add(r.round_id);
      }
      countries = [...seen].sort(([a], [b]) => a.localeCompare(b))
        .map(([country, rounds]) => ({ country, round_count: rounds.size }));
    }

    /**
     * Only periods that exist. A month with no round is not offered, because
     * choosing it would produce a screen of dashes and no way to tell that from
     * a broken filter. Months first, then the rounds inside them.
     */
    /**
     * A month's window is the CALENDAR month, not the span of its rounds.
     *
     * It used to be min(start_date)..max(end_date) of the rounds named for the
     * month, which read as harmlessly descriptive and was the bug: August's
     * window ran to the last day any August round ran — 28 Aug or later — and
     * September's began on 28 Aug, so each month's window overlapped the other's
     * straddling round and the filter, matching by overlap, admitted it whole.
     * Selecting August returned 8,933.95 against By month's 4,997.27.
     *
     * Now that a round is selected by its anchor (anchorOf), and an anchor always
     * falls inside the named month, the calendar month selects exactly the rounds
     * By month reports — no more, no fewer.
     */
    const months = new Map<string, { from: string; to: string }>();
    for (const r of rs) months.set(monthOf(r), monthWindow(monthOf(r)));
    const monthLabel = (k: string) =>
      new Date(`${k}-01T00:00:00Z`).toLocaleDateString("en-SG", {
        month: "long", year: "numeric", timeZone: "UTC",
      });
    const dayLabel = (d: string) =>
      new Date(`${d}T00:00:00Z`).toLocaleDateString("en-SG", {
        day: "numeric", month: "short", timeZone: "UTC",
      })
        // en-SG abbreviates September to "Sept"; every other month gets three
        // letters. The odd one out costs a character in a column that has none
        // to spare, and no reader needs the fourth to know which month it is.
        .replace("Sept", "Sep");
    const dayOnly = (d: string) => String(Number(d.slice(8, 10)));

    /**
     * THE RANGE HAS TO FIT THE COLUMN IT IS PRINTED IN.
     *
     * "0526-02 (SG) · 13 May–19 May" is 28 characters in a 204px nav, so it
     * clipped mid-range — the reader saw "13 May–19…" and had to hover to learn
     * the one thing the label was added to say. Two redundancies were paying
     * for that:
     *
     *   the month, twice, when the round does not cross one — most do not
     *   the market, on every row, when the client only runs in one
     *
     * Neither carries information here. Dropped, the same round reads
     * "0526-02 · 13–19 May" and fits. A round that does cross a month keeps
     * both — "0926-01 · 28 Aug–3 Sep" — because there the second month is the
     * point. And once a client runs MY and SG against the same code, the market
     * comes back on its own, which is exactly when it starts meaning something.
     */
    const markets = new Set(rs.map((r) => r.market).filter(Boolean));
    const range = (from: string, to: string) =>
      from.slice(0, 7) === to.slice(0, 7)
        ? `${dayOnly(from)}–${dayLabel(to)}`
        : `${dayLabel(from)}–${dayLabel(to)}`;

    const periods: Period[] = [
      ...[...months].map(([k, v]) => ({ key: `m:${k}`, label: monthLabel(k), from: v.from, to: v.to })),
      /**
       * A single round selects on its anchor alone — the same day, twice — not on
       * its date span. A span admits any OTHER round anchored inside it, which is
       * the same leak the month options had, one round wide. The LABEL still
       * prints the real dates, because "0926-01 · 28 Aug–3 Sep" is when the class
       * actually ran and that is what a reader needs; only the window narrowed.
       */
      ...rs.map((r) => ({
        key: `r:${r.round_id}`,
        label: `${r.code ?? r.round_id}${r.market && markets.size > 1 ? ` (${r.market})` : ""}`
          + ` · ${range(r.start_date, r.end_date)}`,
        from: anchorOf(r),
        to: anchorOf(r),
      })),
    ];

    return {
      products: (ok(products, "v_products") as Product[] | null) ?? [],
      channels: (ok(channels, "v_client_channels") as ChannelOption[] | null) ?? [],
      countries,
      sources: (buckets.error ? null : (buckets.data as SourceOption[] | null)) ?? [],
      audiences: (audiences.error ? null : (audiences.data as AudienceOption[] | null)) ?? [],
      periods,
    };
  },
  ["funnel-filter-options"],
  /* Six hours. These are the dropdown contents — countries, products, sources,
     rounds — and they change only when an import adds one, which invalidates by
     tag anyway. The country list in particular has been a hotspot since it was
     built, and it is rebuilt on every page that misses this. */
  { tags: [FUNNEL_TAG], revalidate: 64800 },
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
    const scope = {
      p_client: id, p_product: f.product, p_channel: f.channel, p_country: f.country,
      p_source: f.source, p_audience: f.audience, p_attribution: f.attribution, p_periods: f.periods,
    };

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
            .select("run_id, round_id, page_key, page_label, heatmap_path, device, sessions, page_views, captured_from, captured_to, points")
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
  // This round reads v_round_assets, the heaviest query left at ~3s. Worth
  // keeping warm for the same six hours, and the most worth it of the three.
  { tags: [FUNNEL_TAG], revalidate: 64800 },
);

/** The parked queue, only for the tab that shows it. */
// The preview reads only scoped round metadata; it never loads the old
// unsafely aggregated asset/candidate readers for This round.
const loadPreviewRoundSchedule = unstable_cache(
  async (id: string): Promise<RoundSchedule[]> => {
    const db = createReadClient();
    const result = await db.from("rounds").select("round_id,code,start_date,end_date")
      .eq("client_id", id).order("start_date");
    return (ok(result, "preview round schedule") ?? []) as RoundSchedule[];
  },
  ["funnel-preview-round-schedule"],
  { tags: [FUNNEL_TAG], revalidate: 3600 },
);

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

const loadFormAnswers = unstable_cache(
  async (id: string) => {
    const db = createReadClient();
    return (ok(
      await db.from("v_form_answer_split").select("question, answer, leads").eq("client_id", id),
      "v_form_answer_split",
    ) as FormAnswer[] | null) ?? [];
  },
  ["funnel-form-answers"],
  { tags: [FUNNEL_TAG], revalidate: 300 },
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
  allowedClientIds: readonly string[] | null = null,
  wantsReportingPreview = false,
): Promise<Dashboard> {
  try {
    return await build(clientId, requested, filter, allowedClientIds, wantsReportingPreview);
  } catch (e) {
    return explain(e, requested);
  }
}

async function build(
  clientId: string | undefined,
  requested: string,
  filter: FilterKey,
  allowedClientIds: readonly string[] | null,
  wantsReportingPreview: boolean,
): Promise<Dashboard> {
  const allClients = await loadClients();
  const clients = allowedClientIds === null ? allClients
    : allClients.filter((client) => allowedClientIds.includes(client.client_id));
  // Do not load another client's journey or comparison on a restricted
  // account when an explicit/implicit selection is not among its grants.
  if (allowedClientIds !== null && (!clients.length || (clientId && !clients.some((c) => c.client_id === clientId)))) {
    return { ...EMPTY, clients, view: requested, error: null, errorHint: null };
  }

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
  const preview = process.env.NODE_ENV === "development" && wantsReportingPreview
    && id === clientId && isReportingPreviewClient(id) && isReportingPreviewView(requested);
  const previewAnalysis = preview && requested === "analysis";

  // Chrome and the requested tab's data go out together — one wave, not three.
  // The tab is fetched speculatively: confirming it's valid for this client needs
  // the journey stages, and waiting for those would put the waterfall back.
  // Any potential known stage can be configured differently for this client.
  // Only static screens may request a cut before their journey is resolved.
  const wanted = previewAnalysis ? "round" : isFixedReportingView(requested) ? cutFor(requested, filter.asset) : null;
  const [chrome, reportingTotal, vocabulary, options, speculative, detail, formAnswers, previewMonths, previewSchedule] = await Promise.all([
    loadChrome(id),
    loadReportingTotal(id, filter),
    loadJourneyVocabulary(id).catch(() => null),
    loadFilterOptions(id),
    wanted ? loadMetrics(id, wanted, filter) : null,
    NEEDS_UNMATCHED_DETAIL.has(requested) ? loadUnmatchedDetail(id) : null,
    requested === "forms" ? loadFormAnswers(id) : null,
    previewAnalysis ? loadMetrics(id, "month", filter) : null,
    previewAnalysis ? loadPreviewRoundSchedule(id) : null,
  ]);

  // Only This round asks these questions, so only This round pays for them.
  const context = !previewAnalysis && NEEDS_THIS_ROUND.has(requested) ? await loadRoundContext(id, filter) : null;

  const cadences = preview ? previewCadencesFor(options.products, filter.product) : cadencesFor(options.products, filter.product);
  const view = resolveSpine(
    isFixedReportingView(requested) || comparisonStage(chrome.stages, requested) ? requested : "round",
    cadences,
  );

  // Only when the guess was wrong — switching to a client whose journey lacks the
  // open tab — does a second fetch happen, and it's usually a cache hit.
  const effectiveStage = comparisonStage(chrome.stages, view);
  const selection = effectiveStage
    ? stageComparison(effectiveStage, filter.asset, cadences.length === 1 && cadences[0] === "week" ? "week" : "round", preview)
    : null;
  const needsFractionalPurchase = filter.attribution === "even_split"
    && (selection?.legacy === "preview" || selection?.legacy === "middle");
  const comparison = selection && (isComparisonAddress(view) || needsFractionalPurchase)
    ? { ...selection, legacy: null } : selection;
  const settled = previewAnalysis ? "round" : comparison?.cut ?? cutFor(view, filter.asset);
  const metrics = !settled ? null : view === requested && settled === wanted
    ? speculative : await loadMetrics(id, settled, filter);

  /**
   * The columns every part of this screen shows.
   *
   * Drilled into an asset, only that asset's rounds are wanted — and only the
   * two asset tabs have an asset at all, so nothing else can be narrowed by a
   * stray ?asset= in the URL. group_key rather than the label, because the
   * label is prettified and "(unsplit)" is not "Unsplit spend".
   */
  const metricColumns = metrics?.columns ?? [];
  const shown = comparison
    ? comparison.assetCut && filter.asset ? metricColumns.filter((c) => c.group_key === filter.asset) : metricColumns
    : narrowToAsset(metricColumns, view, filter.asset);
  const legacyView = comparison ? comparison.legacy : view;
  const effectiveFilter = comparison && !comparison.assetCut && filter.asset ? { ...filter, asset: null } : filter;
  const strip = buildJourneyStrip({
    stages: chrome.stages, clientId: id, total: reportingTotal, vocabulary,
    sourceKeepsSpend: keepsSpend(filter.source),
  });

  return {
    ...(preview ? {
      reportingPreview: {
        vocabulary,
        ...(previewAnalysis ? { analysis: {
          stages: chrome.stages, vocabulary, roundCuts: shown,
          monthCuts: previewMonths?.columns ?? [], roundSchedule: previewSchedule ?? [],
          sourceKeepsSpend: keepsSpend(filter.source), baseline: metrics?.baseline ?? null,
        } } : {}),
      },
    } : {}),
    clients,
    products: options.products,
    channels: options.channels,
    countries: options.countries,
    sources: options.sources,
    audiences: options.audiences,
    periods: options.periods,
    filter: effectiveFilter,
    cadences,
    stages: chrome.stages,
    comparison,
    strip,
    imports: chrome.imports,
    unmatched: chrome.unmatched,
    total: metrics ? reportingTotal : null,
    baseline: metrics?.baseline ?? null,
    byMonth: NEEDS_MONTHS.has(view) ? shown : [],
    byWeek: NEEDS_WEEKS.has(view) ? shown : [],
    byAd: legacyView !== null && NEEDS_ADS.has(legacyView) ? shown : [],
    bySession: legacyView !== null && NEEDS_SESSION.has(legacyView) ? shown : [],
    byOffer: legacyView !== null && NEEDS_OFFER.has(legacyView) ? shown : [],
    thisRound: NEEDS_THIS_ROUND.has(view) ? shown : [],
    byRound: NEEDS_ROUNDS.has(view) ? shown : [],
    // Drilled in, the columns are one asset's rounds; the tab renders the same
    // table and the same plot, so the narrowing happens here rather than there.
    byAdset: legacyView !== null && NEEDS_ADSETS.has(legacyView) ? shown : [],
    bySource: NEEDS_SOURCES.has(view) ? shown : [],
    byRoundSource: NEEDS_ROUND_SOURCE.has(view) ? shown : [],
    byVariant: legacyView !== null && NEEDS_VARIANT.has(legacyView) ? shown : [],
    byLanding: legacyView !== null && NEEDS_LANDING.has(legacyView) ? shown : [],
    // One slot for both, because the tab already says which asset it is about
    // and the shape is identical either way.
    // The GRAPH reads this and the tables read the lists above. They were two
    // derivations of the same thing and only one was narrowed, so a drilled-in
    // table showed one asset while the plot beside it drew all of them. One
    // list, computed once, used by both.
    columns: shown,
    elsewhere: metrics?.elsewhere ?? null,
    roundContext: context,
    unmatchedReasons: detail?.reasons ?? [],
    unmatchedRows: detail?.rows ?? [],
    formAnswers: formAnswers ?? [],
    view,
    error: null,
    errorHint: null,
  };
}
