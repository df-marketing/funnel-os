import type { ImportStatus, UnmatchedSummary, UnmatchedReason, UnmatchedRow } from "@/lib/funnel/data";
import { ImportUploader } from "./ImportUploader";
import { UnmatchedActions } from "./UnmatchedActions";
import { SOURCES, type SourceKey } from "@/lib/import/sources";

const ORDER: SourceKey[] = ["ads", "leads", "attendance", "sales"];

/**
 * Why the four files go in this order.
 *
 * This isn't presentation: each step reads reference data the previous one
 * wrote. Importing sales before attendance produces sales with no closing
 * credit, and nothing in the diff would tell you that had happened.
 */
const WHY_HERE: Record<SourceKey, string> = {
  ads:        "First, because ad_set is the bridge. A lead's utm_campaign is matched against these ad sets to work out which round's spend produced it.",
  leads:      "Needs the ads file above — without it a lead has no ad set to match and falls back to date-window attribution, which is a guess.",
  attendance: "Needs leads: attendance attaches to a person, and a person becomes known when their lead row lands.",
  sales:      "Last, because a sale's closing credit goes to the most recent class the buyer attended. Attendance has to be in first or that credit is lost.",
};

/** The whole job, start to finish. Rendered above the dropzones. */
const STRAIGHT_LINE = [
  { n: "0", label: "Rounds exist", sub: "set up once per round" },
  { n: "1", label: "Ads", sub: "Meta" },
  { n: "2", label: "Leads", sub: "GoHighLevel" },
  { n: "3", label: "Attendance", sub: "webinar" },
  { n: "4", label: "Sales", sub: "payments" },
  { n: "5", label: "Clear unmatched", sub: "accept or dismiss" },
  { n: "6", label: "Read By round", sub: "the answer" },
];

const REASON_LABEL: Record<string, string> = {
  same_person_two_addresses: "Same person, two addresses",
  phone_format: "Phone format",
  name_only: "Name only, no contact detail",
  bought_without_lead: "Bought without ever being a lead",
};

const sgd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("en-SG", { maximumFractionDigits: 0 });

const when = (iso: string) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return `today ${d.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  return days === 1 ? "yesterday" : `${days} days ago`;
};

/** What each file has to contain, in words rather than column names. */
const NEEDS: Array<{ file: string; must: string; nice: string }> = [
  { file: "Ads",        must: "the date, how much you spent",              nice: "ad set name, impressions, reach, clicks" },
  { file: "Leads",      must: "email, when they signed up",                nice: "phone, where they came from, utm_campaign" },
  { file: "Attendance", must: "which class (0826-01), email",              nice: "join time, minutes watched" },
  { file: "Sales",      must: "date, email, what they bought, how much",   nice: "refund amount and date" },
];

/**
 * The walkthrough a new user reads once.
 *
 * A <details> rather than a modal or a tour: it costs no JavaScript, it's here
 * when wanted and folded away when not, and it opens by itself for a client
 * that has never imported anything — which is exactly when someone is new.
 */
function HowThisWorks({ open }: { open: boolean }) {
  return (
    <details className="how" open={open}>
      <summary>
        <b>How this works</b>
        <span className="dim">seven steps, and what the files need — start here</span>
      </summary>

      <div className="how-b">
        <ol className="how-steps">
          <li>
            <b>Make sure the round exists.</b> A round is one cycle — the ads you ran, the class you
            taught, the offer you made. August&rsquo;s first is <span className="num">0826-01</span>.
            Nothing imports without one, and there&rsquo;s no screen for it yet.
          </li>
          <li>
            <b>Open the app.</b> No login. It lands on Shely, on <b>By round</b>.
          </li>
          <li>
            <b>Glance at the strip along the top.</b> It tells you what&rsquo;s out of date before you
            trust anything. &ldquo;Attendance 4d stale&rdquo; means that file hasn&rsquo;t been updated
            in four days — so show-up rates, and everything after them, are <b>too low right now</b>,
            not wrong forever.
          </li>
          <li>
            <b>Drop four files here, in this order:</b> ads, leads, attendance, sales. The order
            matters — each one needs the one before it. Drop sales first and the app can&rsquo;t tell
            which class closed the sale.
          </li>
          <li>
            <b>Read what it says it will do.</b> Nothing is saved yet. It shows how many rows are new,
            how many changed, and warns you if anything would change a number you have already
            reported to a client.
          </li>
          <li>
            <b>Hit commit.</b> Now it&rsquo;s saved. Rows it couldn&rsquo;t confidently tie to a person
            are set aside rather than counted.
          </li>
          <li>
            <b>Check Unmatched.</b> Someone paid with a different email than they signed up with.
            Accept the suggestion or leave it — the app won&rsquo;t decide for you. Because unsure rows
            wait here, your figures are understated by exactly this queue and never overstated.
          </li>
          <li>
            <b>Read By round.</b> That&rsquo;s the answer you came for.
          </li>
        </ol>

        <h4>Is there a format I have to follow?</h4>
        <p>
          <b>No.</b> Export from Meta, GoHighLevel, your webinar tool and Stripe the way you normally
          do, save as CSV, and drop it in. You don&rsquo;t need to rename columns, reorder them or
          delete anything.
        </p>
        <ul className="how-list">
          <li>It reads your top row of headings and works out which column is which.</li>
          <li>
            It already knows the usual names — <span className="num">Amount spent (SGD)</span>,{" "}
            <span className="num">Day</span>, <span className="num">Reporting starts</span>,{" "}
            <span className="num">Ad set name</span> all land correctly without being told.
          </li>
          <li>Extra columns are ignored, and it lists which ones it ignored so you can see nothing was missed.</li>
          <li>
            If something essential is missing it <b>stops and names it</b> — it will never quietly
            import a column of blanks.
          </li>
          <li>
            It handles the fiddly stuff: commas inside quotes, <span className="num">1,284</span>,{" "}
            <span className="num">SGD 1,378.24</span>, brackets for negatives, and{" "}
            <span className="num">05/06/2026</span> read day-first.
          </li>
        </ul>

        <table className="how-t">
          <thead>
            <tr><th>File</th><th>Must have</th><th>Nice to have</th></tr>
          </thead>
          <tbody>
            {NEEDS.map((n) => (
              <tr key={n.file}>
                <td><b>{n.file}</b></td>
                <td>{n.must}</td>
                <td className="dim">{n.nice}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p>
          <b>One pairing matters more than it looks.</b> The ad set name in the ads file and{" "}
          <span className="num">utm_campaign</span> in the leads file have to match each other. That
          pairing is the only thing connecting money spent to people who showed up — without it the
          app falls back to guessing by date.
        </p>
        <p>
          <b>When in doubt, download a template</b> from under any box below. It&rsquo;s a working file
          with example rows and notes at the bottom: replace the examples with your data, save, drop it
          back in.
        </p>
      </div>
    </details>
  );
}

export function ImportPane({ imports, client }: { imports: ImportStatus[]; client: string }) {
  const stale = imports.filter((i) => i.is_stale);
  // The next file to drop is the first in dependency order that has never landed;
  // once they're all in, the job moves on to clearing the unmatched queue.
  const nextUp = ORDER.find((k) => !imports.some((i) => i.source === k));

  return (
    <>
      <div className="pane-head">
        <h1>Import</h1>
        <p>
          Four files, in the order below. Each one reads what the one before it wrote, so the order
          isn&rsquo;t a suggestion. Nothing lands automatically — drop a file, read the diff, then commit.
        </p>
      </div>

      <HowThisWorks open={imports.length === 0} />

      <ol className="line">
        {STRAIGHT_LINE.map((s) => {
          const done = ORDER.includes(s.label.toLowerCase() as SourceKey)
            ? imports.some((i) => i.source === s.label.toLowerCase())
            : false;
          const here = nextUp && s.label.toLowerCase() === nextUp;
          return (
            <li key={s.n} className={`${done ? "done" : ""}${here ? " here" : ""}`}>
              <span className="n">{done ? "✓" : s.n}</span>
              <span className="l">{s.label}</span>
              <span className="s">{s.sub}</span>
            </li>
          );
        })}
      </ol>

      <div className="notice">
        <span className="ico">!</span>
        <div>
          <b>Step 0 has no screen yet.</b> An import is refused outright if the round it belongs to
          doesn&rsquo;t exist — attendance names a <span className="num">round_id</span> like{" "}
          <span className="num">0826-01</span>, and there has to be a row to attach it to. Rounds are
          currently created by SQL insert, not in the app. That&rsquo;s the one gap left in the straight
          line.
        </div>
      </div>

      <div className="sources">
        {ORDER.map((key, idx) => {
          const spec = SOURCES[key];
          const status = imports.find((i) => i.source === key);
          return (
            <div key={key} className={key === nextUp ? "src-wrap next" : "src-wrap"}>
              <div className="step-h">
                <span className="step-n">{idx + 1}</span>
                <p>{WHY_HERE[key]}</p>
              </div>
              <ImportUploader
                source={key}
                label={spec.label}
                kind={spec.kind}
                client={client}
                expects={spec.fields.map((f) => f.field).join(" · ")}
              />
              <a className="tmpl" href={`/api/template/${key}`} download>
                ↓ Download a filled-in {spec.label.toLowerCase()} template
              </a>
              <dl className="src-status">
                <dt>Last import</dt>
                <dd>
                  {status ? (
                    <span className="fresh">
                      <span className={`dot ${status.is_stale ? "old" : "ok"}`} />
                      {when(status.imported_at)}
                    </span>
                  ) : (
                    <span className="fresh"><span className="dot miss" /> never</span>
                  )}
                </dd>
                <dt>Covers</dt>
                <dd>{status ? `${status.coverage_start ?? "—"} → ${status.coverage_end ?? "—"}` : "—"}</dd>
                <dt>Rows</dt>
                <dd>{status?.row_count?.toLocaleString("en-SG") ?? "—"}</dd>
              </dl>
            </div>
          );
        })}
      </div>

      {stale.length ? (
        <div className="notice">
          <span className="ico">!</span>
          <div>
            <b>
              {stale.map((s) => `${s.source} is ${s.days_since} days stale`).join(", ")}.
            </b>{" "}
            Until it lands, this round&rsquo;s figures downstream of it are understated. Views built on
            it carry the same flag as the header.
          </div>
        </div>
      ) : null}

    </>
  );
}

export function UnmatchedPane({
  summary, reasons, rows,
}: {
  summary: UnmatchedSummary | null;
  reasons: UnmatchedReason[];
  rows: UnmatchedRow[];
}) {
  return (
    <>
      <div className="pane-head">
        <h1>Unmatched</h1>
        <p>
          Rows that couldn&rsquo;t be tied to a person with certainty. None are counted anywhere — so
          every figure in this app is understated by exactly this queue, and never overstated.
        </p>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="lab">Waiting</div>
          <div className="big">{summary?.waiting ?? 0}</div>
          <div className="sub">across {summary?.source_count ?? 0} sources</div>
        </div>
        <div className="tile">
          <div className="lab">Revenue held</div>
          <div className="big">{sgd(summary?.revenue_held)}</div>
          <div className="sub">{summary?.sales_held ?? 0} sales, unassigned</div>
        </div>
        <div className="tile">
          <div className="lab">Auto-resolved</div>
          <div className="big">{summary?.auto_resolved ?? 0}</div>
          <div className="sub">this week, no review</div>
        </div>
      </div>

      <div className="wrap">
        <table className="plain">
          <thead>
            <tr>
              <th>Row</th>
              <th>Source</th>
              <th>Why it didn&rsquo;t match</th>
              <th>Best guess</th>
              <th>Holds</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reasons.map((r) => {
              const group = rows.filter((x) => x.reason === r.reason);
              return (
                <tbody key={r.reason} style={{ display: "contents" }}>
                  <tr className="grp">
                    <td colSpan={6}>
                      {REASON_LABEL[r.reason] ?? r.reason} — {r.rows_waiting} rows
                    </td>
                  </tr>
                  {group.map((x) => {
                    const raw = x.raw_data ?? {};
                    const label =
                      (raw.email as string) ?? (raw.phone as string) ?? (raw.name as string) ?? x.row_id.slice(0, 8);
                    return (
                      <tr key={x.row_id}>
                        <td>{label}</td>
                        <td>{x.source}</td>
                        <td className="dim">{x.guess_method ?? "no contact detail in export"}</td>
                        <td>
                          {x.best_guess ? (
                            <>
                              {x.best_guess}{" "}
                              {x.confidence ? <span className="dim">· {x.confidence} confidence</span> : null}
                            </>
                          ) : (
                            <span className="none">nothing confident enough to offer</span>
                          )}
                        </td>
                        <td className="n">
                          {x.revenue_held && Number(x.revenue_held) > 0 ? `SGD ${sgd(x.revenue_held)}` : "—"}
                        </td>
                        <td>
                          <UnmatchedActions rowId={x.row_id} hasGuess={Boolean(x.best_guess)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="notice info">
        <span className="ico">?</span>
        <div>
          <b>The &ldquo;bought with no lead&rdquo; rows are the interesting ones.</b> Real revenue with
          no ad spend attached — referrals, repeat buyers, or tracking that failed. Crediting them to a
          round would flatter its ROAS, so they stay out of ROAS and appear in revenue totals, labelled.
        </div>
      </div>
    </>
  );
}
