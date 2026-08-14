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
  incomplete_row: "Row is missing something — fix the file",
  no_matching_round: "No round to attach it to — create the round",
  unknown_person: "Contact detail we have, a person we don't",
};

const sgd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("en-SG", { maximumFractionDigits: 0 });

/**
 * These panes render on the server, which runs in UTC — so a locale alone gets
 * the number formatting right and the clock wrong. "today 10:19" for an import
 * made at 18:19 reads like the page is broken. The zone has to be named.
 */
const SG = "Asia/Singapore";

/** YYYY-MM-DD as it is in Singapore right now, whatever the server thinks. */
const localDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: SG });

const when = (iso: string) => {
  const d = new Date(iso);
  // Compared as calendar days in SG, not as 24-hour blocks: an import at 23:00
  // is "yesterday" the next morning, not "0 days ago" until 23:00 again.
  const days = Math.round(
    (Date.parse(localDay(new Date())) - Date.parse(localDay(d))) / 86400000,
  );
  if (days <= 0) {
    return `today ${d.toLocaleTimeString("en-SG", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: SG,
    })}`;
  }
  return days === 1 ? "yesterday" : `${days} days ago`;
};

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

      <div className="notice info">
        <span className="ico">?</span>
        <div>
          <b>There is no fixed export format to match.</b> Column order doesn&rsquo;t matter, extra
          columns are ignored and listed back to you, and the common header spellings are recognised
          already — <span className="num">Amount spent (SGD)</span>, <span className="num">Day</span>{" "}
          and <span className="num">Reporting starts</span> all resolve on their own. Only the required
          fields have to be present under some recognisable name; if one is missing the import is
          refused and the field is named, rather than importing blanks. The templates above are the
          shortest way to see what each file needs.
        </div>
      </div>

      <div className="notice info">
        <span className="ico">→</span>
        <div>
          <b>Then what.</b> Dropping a file parses it, matches every row to a person, works out which
          round produced the lead, and shows the diff — including anything that would restate a figure
          you have already reported. Only then is there a commit button. Rows that couldn&rsquo;t be
          tied to a person land in <b>Unmatched</b>, where you accept or dismiss them; they are never
          guessed and never counted, so figures are understated by exactly that queue and never
          overstated. When it&rsquo;s empty, <b>By round</b> is the answer.
        </div>
      </div>
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
