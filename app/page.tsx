import { getDashboard, type FilterKey } from "@/lib/funnel/data";
import { SpineTable } from "@/components/SpineTable";
import { TopBar, JourneyStrip, SideNav, NotWired, WIRED } from "@/components/Shell";
import { ImportPane, UnmatchedPane } from "@/components/DataPanes";

export const dynamic = "force-dynamic";

const TITLES: Record<string, [string, string]> = {
  import:      ["Import", "Four sources, each on its own cadence. Staleness is surfaced here and in the header."],
  unmatched:   ["Unmatched", "Rows parked rather than guessed at. Never counted, never dropped."],
  month:       ["By month", "Management's first question. Metrics down, months across — the same spine as every other view."],
  week:        ["By week", "The spine that is always there. Rounds only exist when one runs; weeks don't wait."],
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
  lp:       "Deliberately parked. Every other stage tab reads the cut named in its journey config; this one's compare_dimension is null — no landing-page dimension has been decided and no column exists to hold one. Guessing it would put a number on screen that nobody chose. Needs Anis.",
  product:  "Northsea Supply's product-page stage. Same engine, different journey — it appears when that account has rounds.",
  checkout: "Northsea's checkout stage. This tab does not exist in Shely's account at all.",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    client?: string; view?: string;
    product?: string; channel?: string; from?: string; to?: string;
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
  const [title, blurb] = TITLES[view] ?? [view, ""];

  return (
    <>
      <TopBar clients={data.clients} current={current} imports={data.imports} />
      <JourneyStrip strip={data.strip} client={current.client_id} view={view} filter={data.filter} />

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
        />

        <main className="main">
          {view === "import" ? <ImportPane imports={data.imports} client={current.client_id} /> : null}

          {view === "unmatched" ? (
            <UnmatchedPane
              summary={data.unmatched}
              reasons={data.unmatchedReasons}
              rows={data.unmatchedRows}
            />
          ) : null}

          {view === "month" ? (
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

          {view === "week" ? (
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
                    <b>A round belongs to the week it started in</b>, for the same reason it belongs
                    to the month it started in: splitting a round across the boundary would put the
                    spend in one column and the class that spend paid for in the next, and every
                    closing rate would then be measured against a denominator from a different week.
                  </>
                }
                note={
                  <>
                    Weeks exist whether or not a class ran, which is what makes this the dependable
                    axis — a quiet fortnight is two columns of dashes here and simply nothing at all
                    on <b>By round</b>. A week with no round gets no column, because a week nobody
                    was working in is not the same as a week that failed. Reach is not added up here,
                    for the reason given on <b>By month</b>.
                  </>
                }
              />
            </>
          ) : null}

          {view === "round" ? (
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

          {view === "source" ? (
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

          {view === "roundsource" ? (
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

          {view === "targeting" ? (
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

          {view === "ads" ? (
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

          {view === "class" ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title="Class comparison"
                sub="rounds grouped by session label · Class A against Class B"
                baseline={data.baseline}
                total={data.total}
                cuts={data.bySession}
                notice={
                  <>
                    <b>Spend is kept here, not blanked.</b> A class format doesn&rsquo;t buy traffic,
                    but the rounds that ran it did — and cost per attendee by class is the whole
                    reason to compare them. The old sheet protected the class format and could not
                    see what it cost.
                  </>
                }
                note={
                  <>
                    Both of May&rsquo;s rounds ran the same class, so this reads one column today and
                    splits the moment a round with a different{" "}
                    <span className="num">session_label</span> is imported. One column is the true
                    answer, not a broken one.
                  </>
                }
              />
            </>
          ) : null}

          {view === "preview" || view === "middle" ? (
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title={view === "preview" ? "Preview offer by round" : "Middle offer by round"}
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
            <>
              <div className="pane-head">
                <h1>{title}</h1>
                <p>{blurb}</p>
              </div>
              <SpineTable
                title="This round against the last"
                sub="the newest round that has started, beside the one before it"
                baseline={data.baseline}
                total={data.total}
                cuts={data.thisRound}
                notice={
                  <>
                    <b>&ldquo;This round&rdquo; is the newest round that has started</b> — the live
                    one while a round is running, and the one just finished otherwise. A tab that
                    empties itself the day a round ends is a tab nobody checks. Rounds that
                    haven&rsquo;t started are left out: a scheduled round has no figures, and showing
                    it would answer &ldquo;how is it going&rdquo; with a blank.
                  </>
                }
                note={
                  <>
                    Two columns, because a single number with nothing beside it isn&rsquo;t analysis.
                    Reading them against <b>Baseline</b> on the left gives the same comparison every
                    other tab uses.
                  </>
                }
              />
            </>
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
