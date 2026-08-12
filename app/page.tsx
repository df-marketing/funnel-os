import { getDashboard } from "@/lib/funnel/data";
import { SpineTable } from "@/components/SpineTable";
import { TopBar, JourneyStrip, SideNav, NotWired, WIRED } from "@/components/Shell";
import { ImportPane, UnmatchedPane } from "@/components/DataPanes";

export const dynamic = "force-dynamic";

const TITLES: Record<string, [string, string]> = {
  import:      ["Import", "Four sources, each on its own cadence. Staleness is surfaced here and in the header."],
  unmatched:   ["Unmatched", "Rows parked rather than guessed at. Never counted, never dropped."],
  month:       ["By month", "Management's first question. Metrics down, months across — the same spine as every other view."],
  round:       ["By round", "One column per round. Adding 0826-02 adds a column, not a formula."],
  source:      ["By source", "Paid, organic, AOAI and the derived previous-round column."],
  roundsource: ["Round × source", "Both dimensions at once. Any dimension can be the columns; any other can split them."],
  targeting:   ["Targeted views", "Every round's spend on each audience, summed — like for like."],
  ads:         ["Ads", "Creative, not audience. Same rounds, cut by the ad that ran."],
  lp:          ["Landing page", "Only rounds where more than one page ran, so a page isn't credited for traffic it never saw."],
  class:       ["Attend class", "Attendance and closing by class variant — the view the old sheet protected at the cost of ROAS."],
  preview:     ["Preview offer", "The SGD 297 offer made in class."],
  middle:      ["Middle offer", "The SGD 3,000 offer. Seven sales carry most of the revenue."],
  product:     ["Product page", "Northsea Supply's journey has no class and no workshops."],
  checkout:    ["Checkout", "The last stage of Northsea's journey."],
  analysis:    ["This round", "What the round is doing while it runs."],
};

const NOT_WIRED_REASON: Record<string, string> = {
  month:       "The cut is rounds.start_date grouped to a month — the view exists in SQL, the tab just isn't pointed at it yet.",
  source:      "The cut is events.source plus the derived Previous Paid Ads column.",
  roundsource: "The cross-tab needs a two-level column header on the spine table.",
  ads:         "The cut is ads_performance.ad. It needs the utm_campaign bridge resolved to creative grain first — see the note on the Targeted views tab.",
  lp:          "Deliberately parked: the landing-page dimension source is still an open decision and needs Anis. Guessing it would put a wrong number on screen.",
  class:       "The cut is rounds.session_label, with every cost row blank — a class doesn't buy traffic.",
  preview:     "The cut is rounds, filtered to product = 'preview'.",
  middle:      "The cut is rounds, filtered to product = 'middle'.",
  product:     "Northsea's product-page stage. Same engine, different journey.",
  checkout:    "Northsea's checkout stage. This tab does not exist in Shely's account at all.",
  analysis:    "The live round is rounds filtered to the open window, plus period-on-period comparison.",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; view?: string }>;
}) {
  const params = await searchParams;
  const data = await getDashboard(params.client);

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
            <br />
            Open the Supabase SQL editor and run{" "}
            <span className="num">supabase/migrations/ALL.sql</span> — that&rsquo;s the 7-table schema,
            the seed and the 29-metric views, in order.
          </div>
        </div>
      </main>
    );
  }

  const current = data.clients.find((c) => c.client_id === params.client) ?? data.clients[0];
  const slugs = new Set(data.stages.map((s) => s.stage_slug));
  const requested = params.view ?? "round";
  // Switching client keeps the tab only if the new client's journey has it.
  const view = slugs.has(requested) || !["targeting", "ads", "lp", "class", "preview", "middle", "product", "checkout"].includes(requested)
    ? requested
    : "round";

  const [title, blurb] = TITLES[view] ?? [view, ""];

  return (
    <>
      <TopBar clients={data.clients} current={current} imports={data.imports} />
      <JourneyStrip strip={data.strip} client={current.client_id} view={view} />

      <div className="shell">
        <SideNav
          stages={data.stages}
          client={current.client_id}
          view={view}
          unmatchedCount={data.unmatched?.waiting ?? 0}
        />

        <main className="main">
          {view === "import" ? <ImportPane imports={data.imports} /> : null}

          {view === "unmatched" ? (
            <UnmatchedPane
              summary={data.unmatched}
              reasons={data.unmatchedReasons}
              rows={data.unmatchedRows}
            />
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
                    <b>0526-02 gets its revenue back.</b> A lead from that round skipped its own class,
                    attended a later one and bought there. The sale carries both references — so
                    0526-02&rsquo;s spend is credited via <span className="num">lead_round_id</span>, and
                    the later class&rsquo;s closing rate still counts only people who attended it. Both
                    true, both add to the same total.
                  </>
                }
                note={
                  <>
                    May&rsquo;s two rounds returned <b>6.0</b> and <b>9.7</b> on roughly a tenth of
                    today&rsquo;s spend. Whatever changed between May and July is the most valuable
                    question on this screen — and it isn&rsquo;t visible at all in a month view.
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
                    <span className="num">events.utm_campaign → ads_performance.ad_set</span>. Leads with
                    no UTM — organic, and previous-round attendees — cost nothing, so they sit in the
                    Total column and in none of the audience columns. That&rsquo;s why the columns
                    don&rsquo;t sum to the total.
                  </>
                }
                note={
                  <>
                    Two audiences at almost identical spend return very different money. In the sheet
                    those sit in different column blocks on different tabs at different spend levels —
                    the gap only becomes visible once rounds are summed.
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
