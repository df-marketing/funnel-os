import type { ImportStatus, UnmatchedSummary, UnmatchedReason, UnmatchedRow } from "@/lib/funnel/data";
import { ImportUploader } from "./ImportUploader";
import { UnmatchedActions } from "./UnmatchedActions";
import { SOURCES, type SourceKey } from "@/lib/import/sources";

const ORDER: SourceKey[] = ["ads", "leads", "attendance", "sales"];

const SOURCE_META: Record<string, { title: string; kind: string; cols: string }> = {
  ads:        { title: "Ads performance", kind: "Meta export · CSV",      cols: "date · campaign · ad set · ad · spend · impressions · reach · clicks" },
  leads:      { title: "Leads",           kind: "GoHighLevel · API",      cols: "email · phone · created · source · utm_* · tags" },
  attendance: { title: "Attendance",      kind: "Webinar platform · CSV", cols: "session · email · joined at · minutes watched" },
  sales:      { title: "Sales",           kind: "Payments · CSV",         cols: "date · email · product · amount · currency · refunded" },
};

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

export function ImportPane({ imports, client }: { imports: ImportStatus[]; client: string }) {
  const stale = imports.filter((i) => i.is_stale);
  return (
    <>
      <div className="pane-head">
        <h1>Import</h1>
        <p>
          Four sources on their own cadences. Nothing lands automatically — drop the file, see what it
          will do, then commit it.
        </p>
      </div>

      <div className="sources">
        {ORDER.map((key) => {
          const spec = SOURCES[key];
          const status = imports.find((i) => i.source === key);
          return (
            <div key={key}>
              <ImportUploader
                source={key}
                label={spec.label}
                kind={spec.kind}
                client={client}
                expects={spec.fields.map((f) => f.field).join(" · ")}
              />
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
          <b>Nothing lands automatically.</b> Dropping a file parses it, matches every row to a person,
          works out which round produced the lead, and shows you the diff — including anything that
          would restate a figure you have already reported. Only then is there a commit button.
          Unmatched rows are parked, never guessed, and never counted.
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
