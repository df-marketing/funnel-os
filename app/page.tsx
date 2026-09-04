import { getDashboard, type FilterKey } from "@/lib/funnel/data";
import { SpineTable } from "@/components/SpineTable";
import { SpineChart } from "@/components/SpineChart";
import { RoundAnalysis } from "@/components/RoundAnalysis";
import { TopBar, JourneyStrip, SideNav, NotWired, PaneControls, WIRED } from "@/components/Shell";
import { ImportPane, UnmatchedPane } from "@/components/DataPanes";
import { AcqosPane } from "@/components/AcqosPane";
import { loadWire } from "@/lib/funnel/wire";
import { loadDeclaredMetrics } from "@/lib/funnel/metrics";
import {
  DEFAULT_OPTS, defaultVsFor, GRAPHABLE, isObjective, isVs, vsOption, type ViewOpts,
} from "@/lib/funnel/chart";

export const dynamic = "force-dynamic";

const TITLES: Record<string, [string, string]> = {
  import:      ["Import", "Four sources, each on its own cadence. Staleness is surfaced here and in the header."],
  unmatched:   ["Unmatched", "Rows parked rather than guessed at. Never counted, never dropped."],
  acqos:       ["AcqOS", "The wire to the planning side: what it sent us, and what it reads back."],
  month:       ["By month", "Management's first question. Metrics down, months across — the same spine as every other view."],
  week:        ["By week", "For a product that runs continuously. Weeks are always there; rounds only exist when one runs."],
  round:       ["By round", "One column per round. Adding 0826-02 adds a column, not a formula."],
  source:      ["By source", "Paid, organic, AOAI and the derived previous-round column."],
  roundsource: ["Round × source", "Both dimensions at once. Any dimension can be the columns; any other can split them."],
  targeting:   ["Targeted views", "Every round's spend on each audience, summed — like for like."],
  ads:         ["Ads", "Creative, not audience. Same rounds, cut by the ad that ran."],
  lp:          ["Landing page", "Only rounds where more than one page ran, so a page isn't credited for traffic it never saw."],
  class:       ["Attend class", "Attendance and closing by class variant — the view the old sheet protected at the cost of ROAS."],
  preview:     ["Preview offer", "The SGD 297 offer made in class."],
  middle:      ["Middle offer", "The back-end offer. Not one price — May closed at 1,197, 1,298.50, 1,400, 1,700 and 2,000."],
  product:     ["Product page", "Northsea Supply's journey has no class and no workshops."],
  checkout:    ["Checkout", "The last stage of Northsea's journey."],
  analysis:    ["This round", "What the round is doing while it runs."],
};

const NOT_WIRED_REASON: Record<string, string> = {
  product:  "Northsea Supply's product-page stage. Same engine, different journey — it appears when that account has rounds.",
  checkout: "Northsea's checkout stage. This tab does not exist in Shely's account at all.",
};

/**
 * Tabs whose columns can be drilled into, and what one of their columns IS.
 *
 * One list rather than a condition repeated per tab: the variant tab was added
 * to the drill machinery and left out of the way back, so it could be entered
 * and not left.
 */
const DRILL_NOUN: Record<string, string> = {
  targeting: "audiences",
  ads: "creatives",
  class: "sequences",
  lp: "landing pages",
};
const DRILLABLE = new Set(Object.keys(DRILL_NOUN));

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    client?: string; view?: string;
    product?: string; channel?: string; from?: string; to?: string;
    asset?: string;
    mode?: string; objective?: string; vs?: string;
  }>;
}) {
  const params = await searchParams;
  /**
   * The filter lives in the address, not in component state. A filtered screen
   * is therefore a real thing you can reload, bookmark and send to someone —
   * and the server can render it, so there is no flash of unfiltered numbers.
   * An empty string is treated as absent, the same as the database treats it.
   */
  const filter: FilterKey = {
    product: params.product || null,
    channel: params.channel || null,
    from: params.from || null,
    to: params.to || null,
    // Which single asset the ads and targeting tabs are drilled into. Absent
    // means all of them, which is what those tabs have always shown.
    asset: params.asset || null,
  };
  /**
   * Drilling into one asset, and back out again.
   *
   * The same URL machinery as every other filter, so a single creative's whole
   * history is a link you can send to someone — which is the point: "look at
   * what happened to this ad in July" should not require telling them which
   * five controls to set.
   */
  const withAsset = (a: string | null) => {
    const q = new URLSearchParams();
    q.set("client", params.client ?? "");
    if (params.view) q.set("view", params.view);
    for (const k of ["product", "channel", "from", "to", "mode", "objective", "vs"] as const) {
      const v = params[k];
      if (v) q.set(k, v);
    }
    if (a) q.set("asset", a);
    return `/?${q}`;
  };

  /** Table or graph, and what the graph is about. Same rule: the URL is the state. */
  const opts: ViewOpts = {
    mode: params.mode === "graph" ? "graph" : "table",
    objective: isObjective(params.objective) ? params.objective : DEFAULT_OPTS.objective,
    vs: isVs(params.vs) ? params.vs : defaultVsFor(params.view ?? ""),
  };
  const data = await getDashboard(params.client, params.view ?? "round", filter);

  if (data.error) {
    return (
      <main className="main" style={{ maxWidth: 720, margin: "60px auto" }}>
        <div className="pane-head">
          <h1>Funnel OS</h1>
          <p>Reporting and attribution for DriveFunnels.</p>
        </div>
        <div className="notice">
          <span className="ico">!</span>
          <div>
            <b>{data.error}</b>
            {data.errorHint ? (
              <>
                <br />
                {data.errorHint}
              </>
            ) : null}
          </div>
        </div>
      </main>
    );
  }

  const current = data.clients.find((c) => c.client_id === params.client) ?? data.clients[0];
  const view = data.view;
  /**
   * Only the AcqOS tab pays for the wire's bookkeeping — it is three reads that
   * every other tab would make and throw away. Fetched after getDashboard rather
   * than inside it for the same reason: `current` isn't known until the client
   * list has been resolved, and this is a tab nobody opens by accident.
   */
  const wire = view === "acqos" ? await loadWire(current.client_id) : null;
  // Only the Import tab needs to know what else THIS CLIENT measures, and it
  // needs it fresh — a metric declared a minute ago should have a dropzone.
  // Scoped to the client: what the database can measure and what this client
  // counts are different questions, and the heading answers the second.
  const declared = view === "import" ? await loadDeclaredMetrics(current.client_id) : [];
  /**
   * A stage tab is headed by the name the journey gives it, not by one this
   * file invented.
   *
   * The journey strip, the client switcher and the compare list all read
   * stage_name out of client_journey_config — which AcqOS owns and a client can
   * rename. TITLES is keyed by slug and said something different, so every one
   * of Shely's six stages disagreed with the button that opened it: the sidebar
   * offered "Paid Workshop Purchase ($297)" and the page it opened was headed
   * "Preview offer". Two names for one stage on one screen, with nothing saying
   * which of them the numbers belong to.
   *
   * The blurb stays as it is. It says what the tab CUTS BY, which is a
   * different question from what the stage is called and still worth answering
   * — "Targeted views" was never a bad description of an audience breakdown, it
   * was only a bad name for the Ad Impressions stage.
   */
  const stage = data.stages.find((s) => s.stage_slug === view) ?? null;
  const [fallbackTitle, blurb] = TITLES[view] ?? [view, ""];
  const title = stage?.stage_name ?? fallbackTitle;
  /**
   * The graph replaces the table rather than sitting beside it. Two renderings
   * of the same numbers on one screen invites the question of which is
   * authoritative, and the answer would have to be "neither, they're the same",
   * which nobody believes about a chart and a table that disagree by a rounding.
   */
  const showGraph = opts.mode === "graph" && GRAPHABLE.has(view) && WIRED.has(view);
  /**
   * Did choosing this channel actually blank anything?
   *
   * Read off the result rather than recomputed: with spend and revenue both
   * present, ROAS is arithmetic and cannot be null — so a null one under a
   * channel filter is 0028 having removed it. Asking the database again would
   * be a second round trip to learn what the first one already showed.
   */
  const m = (data.total?.m ?? {}) as Record<string, unknown>;
  const channelBlanked =
    !!data.filter.channel && m.roas == null && Number(m.spend ?? 0) > 0 && m.rev != null;

  return (
    <>
      <TopBar clients={data.clients} current={current} imports={data.imports} />
      <JourneyStrip
        strip={data.strip}
        client={current.client_id}
        view={view}
        filter={data.filter}
        opts={opts}
      />

      <div className="shell">
        <SideNav
          stages={data.stages}
          client={current.client_id}
          view={view}
          unmatchedCount={data.unmatched?.waiting ?? 0}
          filter={data.filter}
          products={data.products}
          channels={data.channels}
          periods={data.periods}
          cadences={data.cadences}
          opts={opts}
          channelBlanked={channelBlanked}
        />

        <main className="main">
          <PaneControls client={current.client_id} view={view} filter={data.filter} opts={opts} />

          {/*
            Every tab that can be drilled into gets this, not just the two it was
            written for. The variant tab was left out and there was then no way
            back to both arms except editing the URL — a filter you cannot see is
            a filter you cannot undo, and one you can see but not clear is worse.

            First in the pane, above the plot and the table both. It was
            written after them and rendered after them too, so the only way
            out of a drilled-in tab sat below a screenful of numbers.
          */}
          {DRILLABLE.has(view) && filter.asset ? (
            <div className="notice info" style={{ marginBottom: 12 }}>
              <span className="ico">→</span>
              <div>
                <b>{filter.asset}</b>, round by round — the columns are its rounds, oldest first.
                Every figure is the same arithmetic as the combined view, so these columns sum to
                that tab&rsquo;s column.{" "}
                Clear it with the <b>{filter.asset} ×</b> chip beside Table and Graph, or{" "}
                <a href={withAsset(null)}>go back to all {DRILL_NOUN[view] ?? "columns"}</a>.
              </div>
            </div>
          ) : null}

          {showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineChart
                title="Input against outcome"
                sub={`ad spend against ${vsOption(opts.vs).label.toLowerCase()}`}
                cuts={data.columns}
                vs={opts.vs}
                notice={
                  <>
                    <b>The Total column is not plotted.</b> A total is not a point on this
                    axis — drawn beside the columns it is made of, it would tower over every
                    one of them and flatten the comparison the chart exists to show. It is on
                    the <b>Table</b> view, where a column of its own is exactly what it is.
                  </>
                }
                note={
                  <>
                    The left line never changes — it is what you spent. Everything above picks
                    the right one, so the chart always answers exactly one question of the same
                    rounds.
                  </>
                }
              />
            </>
          ) : null}

          {view === "import" ? <ImportPane imports={data.imports} client={current.client_id} declared={declared} /> : null}

          {/* `now` comes from the server so "6 minutes ago" renders the same
              string on both sides of hydration, and is measured by the clock
              that answered the request rather than the reader's. */}
          {view === "acqos" && wire ? (
            <AcqosPane wire={wire} client={current.client_id} now={new Date().toISOString()} />
          ) : null}

          {view === "unmatched" ? (
            <UnmatchedPane
              summary={data.unmatched}
              reasons={data.unmatchedReasons}
              rows={data.unmatchedRows}
            />
          ) : null}

          {view === "month" && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title="Month comparison"
                sub="one column per calendar month · rounds rolled up, not re-added"
                baseline={data.baseline}
                total={data.total}
                cuts={data.byMonth}
                notice={
                  <>
                    <b>A round belongs to the month it started in.</b> A round that straddles a month
                    boundary lands whole in its opening month rather than being cut in two — splitting
                    it would put the spend in one column and the class that spend paid for in the
                    next, and every closing rate would then be measured against a denominator from a
                    different month. Revenue still counts on the month of the round that produced the
                    lead, exactly as it does on <b>By round</b>.
                  </>
                }
                note={
                  <>
                    A month with a round but no data yet still gets a column, reading{" "}
                    &ldquo;—&rdquo; the whole way down. <b>By round</b> shows those rounds, so this
                    tab shows those months — hiding them would claim the months don&rsquo;t exist.
                    Reach is not added up here. It counts deduplicated people, so a month is not its
                    rounds&rsquo; reach summed — anyone reached in both would be counted twice. It is
                    read off the coarsest figure Meta reported instead, which is the only one that
                    was ever true for the whole month.
                  </>
                }
              />
            </>
          ) : null}

          {view === "week" && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title="Week comparison"
                sub="one column per calendar week · rounds rolled up, not re-added"
                baseline={data.baseline}
                total={data.total}
                cuts={data.byWeek}
                notice={
                  <>
                    <b>This tab appears for products that run weekly, not for every client.</b> A
                    product sold in rounds reports on <b>By round</b> instead, because there every
                    week would hold exactly one round and the two tables would be identical with the
                    week headings saying less. Which one you get is set on the product, so a client
                    running continuous traffic with no classes still has a spine to read.
                  </>
                }
                note={
                  <>
                    A round belongs to the week it started in, for the same reason it belongs to the
                    month it started in: splitting it would put the spend in one column and the
                    result that spend paid for in the next. A week with nothing in it gets no column
                    — a week nobody was working in is not the same as a week that failed. Reach is
                    not added up here, for the reason given on <b>By month</b>.
                  </>
                }
              />
            </>
          ) : null}

          {view === "round" && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title="Round comparison"
                sub="one column per round · adding 0826-02 adds a column, not a formula"
                baseline={data.baseline}
                total={data.total}
                cuts={data.byRound}
                notice={
                  <>
                    <b>A round keeps the revenue its own spend produced.</b> When a lead skips its own
                    class, attends a later one and buys there, the sale carries both references — the
                    spend is credited via <span className="num">lead_round_id</span>, and the later
                    class&rsquo;s closing rate still counts only people who actually attended it. Both
                    true, and they add to the same total exactly once.
                  </>
                }
                note={
                  <>
                    Adding a round adds a column, never a formula. Every rate is derived from the two
                    numbers above it in its own column, so a round with no spend shows &ldquo;—&rdquo;
                    for CPL rather than a zero nobody measured. Roll these columns up a level and you
                    get <b>By month</b>, from the same rows.
                  </>
                }
              />
            </>
          ) : null}

          {view === "source" && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title="Source comparison"
                sub="one column per acquisition source · summed across every round"
                baseline={data.baseline}
                total={data.total}
                cuts={data.bySource}
                notice={
                  <>
                    <b>Only the paid column carries spend.</b> An AOAI member and an organic lead
                    cost nothing to acquire, so their spend isn&rsquo;t zero — it doesn&rsquo;t exist,
                    and every cost and ROAS row on those columns is blank rather than dividing by
                    nothing. <b>Previous Paid Ads</b> is derived, not a source: a paid lead whose
                    closing round isn&rsquo;t the round that produced them.
                  </>
                }
                note={
                  <>
                    The columns sum to the total, and the total matches{" "}
                    <b>By round</b> — the same events, cut a different way. A source with no leads
                    yet has no column at all.
                  </>
                }
              />
            </>
          ) : null}

          {view === "lp" && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title={filter.asset ? `${filter.asset}, round by round` : "Landing page comparison"}
                sub={
                  filter.asset
                    ? "the rounds this page ran in, oldest first"
                    : "one column per page · the campaign that pointed at it carries the spend, so cost per lead is answerable here"
                }
                baseline={data.baseline}
                total={data.total}
                cuts={data.byLanding}
                drillTo={filter.asset ? undefined : (c) => withAsset(c.cut_key)}
                notice={
                  <>
                    <b>The page is read from the campaign name, not stored.</b> Six spellings across
                    the account — <span className="num">LP1GHL</span>,{" "}
                    <span className="num">LP1GHLHenry</span>,{" "}
                    <span className="num">LP1GHL(0826_02)</span> — and the{" "}
                    <span className="num">LP1</span> / <span className="num">LP2</span> token is the
                    only thing they agree on. Two campaigns say <span className="num">LP</span> with
                    no number and are left out rather than guessed into a column; the rounds before
                    the test carry no page at all, which is not a third page and not a zero.
                  </>
                }
              />
            </>
          ) : null}

          {view === "class" && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title={filter.asset ? `${filter.asset}, round by round` : "Variant comparison"}
                sub={
                  filter.asset
                    ? "the rounds this arm ran in, oldest first"
                    : "one column per arm · read Attendance % first, it is what a reminder sequence moves"
                }
                baseline={data.baseline}
                total={data.total}
                cuts={data.byVariant}
                drillTo={filter.asset ? undefined : (c) => withAsset(c.cut_key)}
                notice={
                  <>
                    <b>Spend is blank here, and that is the honest answer.</b> The ads were bought
                    before anyone was sorted into an arm, so no money belongs to one — splitting it
                    would invent a cost per lead nobody paid. What a variant moves is what happens
                    to people already here: <b>Attendance %</b>, then purchases.{" "}
                    <b>Read the rounds before believing the total.</b> An arm can win overall and
                    lose most rounds.
                  </>
                }
              />
            </>
          ) : null}

          {view === "roundsource" && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title="Round × source"
                sub="rounds across the top, each split by where the person came from"
                baseline={data.baseline}
                total={data.total}
                cuts={data.byRoundSource}
                notice={
                  <>
                    <b>Each round&rsquo;s Total is taken from By round, not re-added here.</b> The two
                    tabs read the same number by construction, so they can&rsquo;t drift apart. A
                    source column only exists in a round where that source actually has rows —
                    an empty column would read as a zero that was measured.
                  </>
                }
                note={
                  <>
                    Leads and attendance count on the round whose class it was; revenue counts on
                    the round whose spend produced the lead. Splitting by source doesn&rsquo;t change
                    which round a sale belongs to — that&rsquo;s what <b>Previous Paid Ads</b> is for.
                  </>
                }
              />
            </>
          ) : null}

          {/*
            Drilled in, the columns stopped being assets and became rounds. That
            is a different question on the same tab, so it says so — and offers
            the way back, because a filter you cannot see is a filter you cannot
            undo.
          */}

          {view === "targeting" && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title="Audience comparison"
                sub="every round's spend on each audience, summed"
                baseline={data.baseline}
                total={data.total}
                cuts={data.byAdset}
                drillTo={filter.asset ? undefined : (c) => withAsset(c.group_key ?? c.cut_key)}
                notice={
                  <>
                    <b>Audiences are bridged from people to ads by</b>{" "}
                    <span className="num">events.ad_set → ads_performance.ad_set</span>. A paid
                    lead whose UTM went missing still cost money, so it lands in{" "}
                    <b>Unsplit spend</b> rather than nowhere — no ad set is not the same as no ad.
                    Organic and community leads have no column at all, because for them there was no
                    ad. That&rsquo;s why the columns don&rsquo;t sum to the total.
                  </>
                }
                note={
                  <>
                    Audiences at almost identical spend can differ by more than 2× on cost per
                    attendee — and the one that looks worst on cost per lead is often not the one
                    that looks worst on cost per attendee. In the sheet
                    those sit in different column blocks on different tabs at different spend levels —
                    the gap only becomes visible once rounds are summed.
                  </>
                }
              />
            </>
          ) : null}

          {view === "ads" && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title="Creative comparison"
                sub="one column per ad · ordered by the leads it produced"
                baseline={data.baseline}
                total={data.total}
                cuts={data.byAd}
                drillTo={filter.asset ? undefined : (c) => withAsset(c.group_key ?? c.cut_key)}
                notice={
                  <>
                    <b>Spend and impressions are per creative; reach and clicks are not.</b> Both
                    halves come from Meta&rsquo;s ad-level export, and both are additive, so cost per
                    lead by creative is answerable here. Reach is deduplicated people and is only
                    true at the level it was queried — the creatives add up to more than the ad sets
                    they ran in — so it is left blank rather than overstated, and CTR, CPM and CPC go
                    with it. Which ad produced a lead comes from a different source entirely,
                    GoHighLevel&rsquo;s <span className="num">utm_content</span>.
                    <br />
                    <br />
                    Attendance here can come to less than the figure on <b>By round</b>. An attendee
                    whose own opt-in row parked is known by email but has no lead, so nothing records
                    an ad for them — they can&rsquo;t be credited to a creative that may not exist,
                    and they appear on every tab cut by round and on none cut by ad.{" "}
                    <b>Targeted views</b> is short by the same people, for the same reason.
                  </>
                }
                note={
                  <>
                    <b>Ad ID only</b> is one column standing for every ad whose{" "}
                    <span className="num">utm_content</span> carried an ID instead of a name, because
                    a second tracking template writes{" "}
                    <span className="num">{"{{ad.id}}"}</span> where the others write the ad&rsquo;s
                    name. None of them appears in the ad-level export, so they carry leads and no
                    spend — and each one splits back out into its own column the moment Meta reports
                    an ad answering to that ID.
                    <br />
                    <br />
                    They are collapsed rather than dropped because those leads are real people, and
                    a tab that reads short of <b>By round</b> without saying why is the failure this
                    one is built to avoid. It is worth reading the row: leads, and no attendance at
                    all. Ads nobody can name produced nobody who came.
                  </>
                }
              />
            </>
          ) : null}


          {(view === "preview" || view === "middle") && !showGraph ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title={`${title} by round`}
                sub="the same rounds as By round, with one offer's numbers filled in"
                baseline={data.baseline}
                total={data.total}
                cuts={data.byOffer}
                notice={
                  <>
                    <b>The other offer&rsquo;s rows are blank, not zero.</b> A round that sold no{" "}
                    {view === "preview" ? "preview" : "middle"} offer and a round whose{" "}
                    {view === "preview" ? "middle" : "preview"} numbers simply aren&rsquo;t this
                    tab&rsquo;s subject are different things, and only one of them is a measurement.
                    Spend, leads and attendance are the round&rsquo;s own and are shown in full.
                  </>
                }
                note={
                  <>
                    Both offer tabs read one view told apart by a product filter, so a metric
                    can&rsquo;t mean one thing here and another on the other tab. The numbers are the
                    same rows as <b>By round</b>, filtered rather than recomputed.
                  </>
                }
              />
            </>
          ) : null}

          {view === "analysis" ? (
            <RoundAnalysis
              cuts={data.columns}
              baseline={data.baseline}
              context={data.roundContext}
              objective={opts.objective}
              /* rendered on the server, so the day is named rather than inherited
                 from whatever zone the machine happens to be in */
              today={new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" })}
            />
          ) : null}

          {!WIRED.has(view) ? (
            <NotWired title={title} blurb={blurb} reason={NOT_WIRED_REASON[view] ?? ""} />
          ) : null}
        </main>
      </div>

      <footer>
        <b>Funnel OS.</b> Shely&rsquo;s figures are the master-sheet numbers, in the sheet&rsquo;s own
        metric order and grouping. Blank means absent, not zero — a rate with no denominator shows
        &ldquo;—&rdquo; and never <span className="num">#DIV/0!</span>.
      </footer>
    </>
  );
}
