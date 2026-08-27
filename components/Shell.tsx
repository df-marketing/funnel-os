import Link from "next/link";
import { fmtCount, type MetricKey, type Metrics } from "@/lib/funnel/spine";
import { RefreshButton } from "./RefreshButton";
import { SOURCES, type SourceKey } from "@/lib/import/sources";
import type {
  Client, Stage, StripCard, ImportStatus, Product, ChannelOption, FilterKey, Cadence,
} from "@/lib/funnel/data";
import {
  DEFAULT_OPTS, OBJECTIVE_KEYS, OBJECTIVES, GRAPHABLE, VS_OPTIONS, type ViewOpts,
} from "@/lib/funnel/chart";

/**
 * Every link carries the whole filter, so a filtered screen survives clicking
 * to another tab and can be pasted to someone else and land the same.
 * Empty values are dropped rather than sent as "" — the URL should say what is
 * set, not carry four blanks on every page.
 */
const href = (client: string, view: string, f?: FilterKey, o?: ViewOpts) => {
  const q = new URLSearchParams({ client, view });
  if (f?.product) q.set("product", f.product);
  if (f?.channel) q.set("channel", f.channel);
  if (f?.from) q.set("from", f.from);
  if (f?.to) q.set("to", f.to);
  // Carried on every link so switching tabs keeps you in the graph you were
  // reading, instead of dropping you back into the table each time.
  if (o && o.mode !== DEFAULT_OPTS.mode) q.set("mode", o.mode);
  if (o && o.objective !== DEFAULT_OPTS.objective) q.set("objective", o.objective);
  if (o && o.vs !== DEFAULT_OPTS.vs) q.set("vs", o.vs);
  return `/?${q}`;
};

/**
 * Views that exist regardless of the client's journey.
 *
 * "week" and "round" are both here even though a given product only offers one
 * of them: this list is about which URLs are legal, not which are in the
 * sidebar. Cadence decides the sidebar — see `cadencesFor` in data.ts — and a
 * URL for the wrong spine is redirected to the right one rather than 404'd.
 */
export const FIXED_VIEWS = ["import", "unmatched", "month", "week", "round", "source", "roundsource", "analysis"];

/** Which tabs are wired to real Supabase data today. Everything else says so. */
export const WIRED = new Set([
  "month", "week", "round", "source", "roundsource",
  "targeting", "ads", "class", "preview", "middle",
  "analysis", "import", "unmatched", "acqos",
]);

export function TopBar({
  clients, current, imports,
}: {
  clients: Client[];
  current: Client;
  imports: ImportStatus[];
}) {
  const stale = imports.filter((i) => i.is_stale);
  /**
   * A source that has NEVER been imported has no batch, so it has no last-import
   * date, so it can't be stale — and the header used to read "All sources
   * current" while Sales said "never" on the tab below it. Absence was passing
   * as freshness. Missing is a louder problem than stale, so it's said first.
   */
  const missing = (Object.keys(SOURCES) as SourceKey[]).filter(
    // An optional source that was never imported is not a gap. No round has to
    // have a Clarity export, and a permanent fifth warning beside four real
    // ones is how people learn to stop reading all five.
    (k) => !SOURCES[k].optional && !imports.some((i) => i.source === k),
  );
  const coverage = imports
    .map((i) => i.coverage_end)
    .filter(Boolean)
    .sort() as string[];
  const span = coverage.length
    // rendered on the server, so the zone is named rather than inherited — see
    // the note on `when` in DataPanes
    ? new Date(coverage[coverage.length - 1]).toLocaleDateString("en-SG", {
        month: "short", year: "numeric", timeZone: "Asia/Singapore",
      })
    : "—";

  return (
    <div className="top">
      <div className="brand">
        <b>Funnel OS</b>
        <span>{current.client_name ?? current.client_id}</span>
      </div>

      {/* Client switcher — driven entirely by client_journey_config */}
      <div className="seg" role="group" aria-label="Client">
        {clients.map((c) => (
          <Link
            key={c.client_id}
            href={href(c.client_id, "round")}
            aria-pressed={c.client_id === current.client_id}
          >
            {c.client_name ?? c.client_id}
          </Link>
        ))}
      </div>

      <span className="meta">{current.client_note}</span>
      <div className="spacer" />

      {/* Staleness is surfaced in the header and propagates to every view below */}
      {missing.length || stale.length ? (
        <>
          {missing.map((k) => (
            <span className="meta fresh" key={k}>
              <span className="dot old" />
              {SOURCES[k].label} never imported
            </span>
          ))}
          {stale.map((s) => (
            <span className="meta fresh" key={s.source}>
              <span className="dot old" />
              {s.source[0].toUpperCase() + s.source.slice(1)}
              {s.days_behind ? ` ${s.days_behind}d` : ""} stale
            </span>
          ))}
        </>
      ) : (
        <span className="meta fresh">
          <span className="dot ok" />
          All sources current
        </span>
      )}
      <span className="meta">
        through {span} · <b>SGD</b>
      </span>
      <RefreshButton />
    </div>
  );
}

/**
 * Which spine metric each journey stage counts, and which rate goes under it.
 *
 * The same mapping v_journey_strip does in SQL, moved here so the card is read
 * off the metric object fo_cut returns — which is the object that channel
 * blanking is applied to. Reading the view's own flat columns instead would put
 * an unblinded Lead Gen % on the strip directly above a table that blanks it.
 */
const STAGE_METRIC: Record<string, { value: MetricKey; rate?: MetricKey }> = {
  impressions:       { value: "impr" },
  clicks:            { value: "clicks",  rate: "ctr" },
  leads:             { value: "leads",   rate: "leadgen" },
  attendance:        { value: "att",     rate: "attPct" },
  preview_purchases: { value: "prevBuy", rate: "prevPct" },
  middle_purchases:  { value: "midBuy",  rate: "midPct" },
};

const cardNumbers = (s: StripCard) => {
  const map = s.stage_metric ? STAGE_METRIC[s.stage_metric] : undefined;
  const m = (s.m ?? null) as Metrics | null;
  // Falls back to the view's flat columns for a database that hasn't run 0031.
  if (!map || !m) return { value: s.value, rate: s.rate };
  return {
    value: (m[map.value] ?? null) as string | number | null,
    rate: map.rate ? ((m[map.rate] ?? null) as string | number | null) : null,
  };
};

export function JourneyStrip({
  strip, client, view, filter, opts,
}: {
  strip: StripCard[];
  client: string;
  view: string;
  filter: FilterKey;
  opts: ViewOpts;
}) {
  return (
    <section className="journey">
      <div className="journey-head">
        <h2>Customer journey</h2>
        <p>Each stage has a comparison view. Change the journey and the views change with it.</p>
      </div>
      <div className="stages">
        {strip.map((s) => {
          const { value, rate } = cardNumbers(s);
          return (
            <Link
              className="stage"
              key={s.stage_slug}
              href={href(client, s.stage_slug, filter, opts)}
              aria-current={view === s.stage_slug}
            >
              <span className="sname">{s.stage_name}</span>
              <span className="sval">{fmtCount(value)}</span>
              <span className="srate">
                {rate !== null && rate !== undefined
                  ? `${Number(rate).toFixed(1)}% ${s.stage_rate_label ?? ""}`.trim()
                  : (s.stage_rate_label ?? "")}
              </span>
              <span className="sarrow" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Product · Channel · Period, above everything else in the nav.
 *
 * Rendered as links rather than a form so a filtered screen has a real address:
 * it survives a reload, a click to another tab, and being pasted to someone
 * else. No client-side state, nothing to get out of step with the URL.
 *
 * A dimension with only one option still renders, greyed. Hiding it would say
 * the client has no products; showing one says they have exactly one.
 */
function FilterBar({
  client, view, filter, products, channels, periods, opts, channelBlanked,
}: {
  /** True only when choosing this channel actually blanked some rates. */
  channelBlanked: boolean;
  client: string;
  view: string;
  filter: FilterKey;
  opts: ViewOpts;
  products: Product[];
  channels: ChannelOption[];
  periods: { key: string; label: string; from: string | null; to: string | null }[];
}) {
  const row = (
    label: string,
    options: { key: string | null; label: string; sub?: string; dim?: boolean }[],
    active: string | null,
    build: (key: string | null) => FilterKey,
  ) => (
    <div className="filter-row">
      <span className="filter-label">{label}</span>
      <div className="filter-opts">
        {options.map((o) => (
          <Link
            key={o.key ?? "all"}
            href={href(client, view, build(o.key), opts)}
            className={`filter-opt${o.dim ? " dim" : ""}`}
            aria-pressed={active === o.key}
            title={o.sub}
          >
            {o.label}
          </Link>
        ))}
      </div>
    </div>
  );

  const periodKey =
    periods.find((p) => p.from === filter.from && p.to === filter.to)?.key ?? null;

  return (
    <div className="filters">
      {row(
        "Product",
        [
          { key: null, label: "All" },
          ...products.map((p) => ({
            key: p.product_id,
            label: p.product_name,
            sub: p.product_note ?? undefined,
            dim: p.round_count === 0,
          })),
        ],
        filter.product,
        (product) => ({ ...filter, product }),
      )}
      {row(
        "Channel",
        [
          { key: null, label: "All" },
          ...channels.map((c) => ({
            key: c.channel,
            label: c.channel,
            sub: c.note ?? undefined,
          })),
        ],
        filter.channel,
        (channel) => ({ ...filter, channel }),
      )}
      {row(
        "Period",
        [
          { key: null, label: "All time" },
          ...periods.map((p) => ({ key: p.key, label: p.label })),
        ],
        periodKey,
        (key) => {
          const p = periods.find((x) => x.key === key);
          return { ...filter, from: p?.from ?? null, to: p?.to ?? null };
        },
      )}
      {/*
        Said only while a channel is chosen, and the second half only when
        something actually went blank. The old version explained the blanking
        rule every time, including on an account where only one channel has ever
        run and nothing blanks — a paragraph of theory above a screen it did not
        apply to.
      */}
      {filter.channel ? (
        <p className="filter-note">
          Spend and delivery narrow to {filter.channel}. Leads, attendance and sales
          don&rsquo;t carry a platform, so they stay whole.
          {channelBlanked ? (
            <>
              {" "}
              <b>ROAS, CPA, CPL and Lead gen % are blank</b> because more than one channel ran
              here — dividing all the revenue by one channel&rsquo;s spend would credit it with
              the other&rsquo;s results.
            </>
          ) : (
            <>
              {" "}
              Only {filter.channel} ran here, so this filter took nothing away and every rate
              still stands.
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}

export function SideNav({
  stages, client, view, unmatchedCount, filter, products, channels, periods, cadences, opts,
  channelBlanked,
}: {
  stages: Stage[];
  client: string;
  view: string;
  unmatchedCount: number;
  filter: FilterKey;
  products: Product[];
  channels: ChannelOption[];
  periods: { key: string; label: string; from: string | null; to: string | null }[];
  /** Which of By week and By round this selection has something to put in. */
  cadences: Cadence[];
  opts: ViewOpts;
  channelBlanked: boolean;
}) {
  const item = (slug: string, label: React.ReactNode) => (
    <Link key={slug} href={href(client, slug, filter, opts)} aria-current={view === slug ? "page" : undefined}>
      {label}
    </Link>
  );

  return (
    <nav className="nav">
      <FilterBar
        client={client}
        view={view}
        filter={filter}
        opts={opts}
        channelBlanked={channelBlanked}
        products={products}
        channels={channels}
        periods={periods}
      />

      <div className="nav-group">Data</div>
      {item("import", "Import")}
      {item(
        "unmatched",
        <>
          Unmatched {unmatchedCount ? <span className="badge">{unmatchedCount}</span> : null}
        </>,
      )}
      {/*
        Under Data, not under its own heading: the wire is where a funnel comes
        from and where the readings go, which is the same question as where the
        four files come from. It is one more source, and the one nobody drops.
      */}
      {item("acqos", "AcqOS")}

      <div className="nav-group">Overview</div>
      {item("month", "By month")}
      {/*
        One spine, chosen by what the selected product actually runs. Showing
        both to a client who only runs rounds put two identical tables in the
        sidebar; hiding week outright put a per-client fact in the source code.
        The product says which, so neither mistake is available here.
      */}
      {cadences.includes("week") ? item("week", "By week") : null}
      {cadences.includes("round") ? item("round", "By round") : null}
      {item("source", "By source")}
      {item("roundsource", "Round × source")}

      <div className="nav-group">
        Compare <span className="derived">one per journey stage</span>
      </div>
      {stages.map((s) => item(s.stage_slug, s.stage_name))}

      <div className="nav-group">Now</div>
      {item("analysis", "This round")}
    </nav>
  );
}

/**
 * Table / Graph, and what the graph is about.
 *
 * Sits in the pane head rather than the sidebar because it describes THIS tab,
 * not the whole account — and it is links, like everything else, so a graph of
 * cost per attendance by round is an address someone else can open.
 *
 * The objective picker only appears in graph mode. In the table every metric is
 * already on screen, so choosing one would change nothing and imply it did.
 */
export function PaneControls({
  client, view, filter, opts,
}: {
  client: string;
  view: string;
  filter: FilterKey;
  opts: ViewOpts;
}) {
  /**
   * This round has no table/graph switch — it is neither — but it does have an
   * objective, and it is the same objective the graph uses. One choice, carried
   * in one URL parameter, meaning the same thing on both screens.
   */
  const objectiveOnly = view === "analysis";
  if (!GRAPHABLE.has(view) && !objectiveOnly) return null;
  if (objectiveOnly) {
    return (
      <div className="pane-controls">
        <div className="objective">
          <span className="filter-label">Objective</span>
          <div className="filter-opts">
            {OBJECTIVE_KEYS.map((k) => (
              <Link
                key={k}
                href={href(client, view, filter, { ...opts, objective: k })}
                className="filter-opt"
                aria-pressed={opts.objective === k}
                title={`The goal metric on this screen`}
              >
                {OBJECTIVES[k].label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="pane-controls">
      <div className="seg small" role="group" aria-label="View">
        <Link href={href(client, view, filter, { ...opts, mode: "table" })} aria-pressed={opts.mode === "table"}>
          Table
        </Link>
        <Link href={href(client, view, filter, { ...opts, mode: "graph" })} aria-pressed={opts.mode === "graph"}>
          Graph
        </Link>
      </div>

      {/*
        One selection across eight, in two labelled rows.
        Was Objective (four) x Spend-vs (two), which put the same metric name in
        both rows at once. The rows group; they do not compose.
      */}
      {opts.mode === "graph" ? (
        <div className="vs">
          {(["amount", "efficiency"] as const).map((kind) => (
            <div className="vs-row" key={kind}>
              <span className="filter-label">{kind === "amount" ? "Spend vs" : "or efficiency"}</span>
              <div className="filter-opts">
                {VS_OPTIONS.filter((o) => o.kind === kind).map((o) => (
                  <Link
                    key={o.key}
                    href={href(client, view, filter, { ...opts, vs: o.key })}
                    className="filter-opt"
                    aria-pressed={opts.vs === o.key}
                    title={`Plot ad spend against ${o.label}`}
                  >
                    {o.short}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function NotWired({ title, blurb, reason }: { title: string; blurb: string; reason: string }) {
  return (
    <>
      <div className="pane-head">
        <h1>{title}</h1>
        <p>{blurb}</p>
      </div>
      <div className="notice info">
        <span className="ico">?</span>
        <div>
          <b>Not wired yet.</b> {reason} The nav, the journey strip and the metric spine are the same
          engine as the wired views — this tab needs its cut defined, not new machinery.
        </div>
      </div>
    </>
  );
}
