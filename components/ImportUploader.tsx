"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ImportMappingReview, type ConfirmedReview, type ImportMappingView } from "./ImportMappingReview";
import { LeadRoundEvidence } from "./LeadRoundEvidence";
import type { LeadDestination, RoundTagEvidence } from "@/lib/import/lead-round-evidence";

type Summary = {
  unchanged?: boolean;
  source: string; fileName: string; rowCount: number;
  review?: { worksheet?: string; profile?: { name: string; revision: number } };
  coverage: { start: string | null; end: string | null };
  columnMap: Record<string, string>; unusedColumns: string[];
  counts: { matchedExact: number; matchedAuto: number; newContacts: number; parked: number; duplicates: number; unidentified: number };
  attribution: { utm: number; dateWindow: number; none: number };
  diff: { newRows: number; changedRows: number; restatements: string[] };
  warnings: string[];
  prerequisite: string | null;
  leadDestinations?: LeadDestination[];
  willWrite: { contacts: number; events: number; ads: number; unmatched: number; refunds: number; answers: number };
  scroll: {
    round: string; device: string; sessions: number;
    pageViews: number | null; points: number; replaces: boolean;
  } | null;
};

/**
 * The empties dropped before the separator goes in, rather than each caller
 * remembering to lead with one. Building these by hand is what produced
 * "1401 leads gain form answersnothing new": a fourth kind of write was added
 * beside three that already knew about each other.
 */
const joinParts = (parts: string[]) => parts.filter(Boolean).join(" · ");

type ChosenFile = { file: File; source: string; sheet?: { id: string; name: string } };
type Inspection =
  | { kind: "worksheets"; sheets: { id: string; name: string; selectable: boolean }[] }
  | { kind: "source"; message: string; detail?: string[]; roundTagEvidence?: RoundTagEvidence | null; candidates: { source: string; label: string; why?: string }[] }
  | { kind: "legacy"; source: string; profileReason: string }
  | ImportMappingView;

type State =
  | { phase: "idle" }
  | { phase: "reading" }
  | { phase: "review"; chosen: ChosenFile; view: Inspection }
  | { phase: "staged"; batchId: string; plan: Summary }
  | { phase: "committing"; batchId: string; plan: Summary }
  | { phase: "done"; plan: Summary; unchanged: boolean }
  | { phase: "error"; message: string; detail: string[] };

type UploaderProps = { source: string; label: string; kind: string; client: string; expects: string };

export function ImportUploader(props: UploaderProps) {
  return <ImportUploaderForScope key={`${props.client}:${props.source}`} {...props} />;
}

function ImportUploaderForScope({ source, label, kind, client, expects }: UploaderProps) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const staging = useRef(false);
  const latestRead = useRef(0);

  function uploadBody(chosen: ChosenFile) {
    const body = new FormData();
    body.append("file", chosen.file);
    body.append("source", chosen.source);
    body.append("client", client);
    if (chosen.sheet) body.append("sheet", chosen.sheet.id);
    return body;
  }

  async function inspect(chosen: ChosenFile) {
    const read = ++latestRead.current;
    setState({ phase: "reading" });
    try {
      const response = await fetch("/api/import/inspect", { method: "POST", body: uploadBody(chosen) });
      const json = await response.json();
      if (read !== latestRead.current) return;
      if (!response.ok) {
        setState({ phase: "error", message: json.error ?? "Could not review the file.", detail: json.detail ?? [] });
        return;
      }
      setState({ phase: "review", chosen, view: json });
    } catch {
      if (read === latestRead.current) setState({ phase: "error", message: "Could not reach the server.", detail: [] });
    }
  }

  async function upload(chosen: ChosenFile, review?: ConfirmedReview) {
    if (staging.current) return;
    staging.current = true;
    setState({ phase: "reading" });
    const body = uploadBody(chosen);
    if (review) body.append("reviewed", JSON.stringify(review));
    try {
      const res = await fetch("/api/import/preview", { method: "POST", body });
      const json = await res.json();
      if (!res.ok) {
        const details = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
        setState({ phase: "error", message: json.error ?? "Import failed.", detail: [...new Set([...details(json.detail), ...details(json.hints)])] });
        return;
      }
      setState({ phase: "staged", batchId: json.batchId, plan: json.plan });
    } catch {
      setState({ phase: "error", message: "Could not reach the server.", detail: [] });
    } finally {
      staging.current = false;
    }
  }

  async function commit(batchId: string, plan: Summary) {
    setState({ phase: "committing", batchId, plan });
    try {
      const res = await fetch("/api/import/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setState({ phase: "error", message: json.error ?? "Commit failed.", detail: [] });
        return;
      }
      setState({ phase: "done", plan, unchanged: json.unchanged === true });
      router.refresh();
    } catch {
      setState({ phase: "error", message: "Could not reach the server.", detail: [] });
    }
  }

  async function discard(batchId: string) {
    await fetch("/api/import/commit", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchId }),
    });
    setState({ phase: "idle" });
    router.refresh();
  }

  const p = state.phase;

  return (
    <div className="src">
      <div className="src-h">
        <h3>{label}</h3>
        <span className="kind">{kind}</span>
      </div>
      <div className="src-b">
        {p === "review" && (() => {
          const { chosen, view } = state;
          const startOver = () => { latestRead.current++; setState({ phase: "idle" }); };
          if (view.kind === "mapping") return <ImportMappingReview view={view} client={client} worksheet={chosen.sheet?.name}
            onStartOver={startOver} onPreview={(review) => void upload({ ...chosen, source: view.source }, review)} />;
          if (view.kind === "legacy") return (
            <div className="notice">
              <div>
                <b>Ready to preview</b>
                <p>{view.profileReason}</p>
                <button className="btn primary" type="button" onClick={() => void upload({ ...chosen, source: view.source })}>Preview import</button>{" "}
                <button className="linkish" type="button" onClick={startOver}>Choose a different file</button>
              </div>
            </div>
          );
          return (
            <div className="notice">
              <span className="ico">?</span>
              <div>
                <b>{view.kind === "worksheets" ? "Choose one worksheet" : view.message}</b>
                {view.kind === "source" && view.detail?.length ? <ul>{view.detail.map((detail) => <li key={detail}>{detail}</li>)}</ul> : null}
                {view.kind === "source" && view.roundTagEvidence ? <LeadRoundEvidence evidence={view.roundTagEvidence} chooseSource /> : null}
                <div className="amb">
                  {view.kind === "worksheets"
                    ? view.sheets.map((sheet) => <button className="amb-pick" type="button" key={sheet.id} disabled={!sheet.selectable}
                        onClick={() => void inspect({ ...chosen, sheet })}>{sheet.name}{!sheet.selectable ? " (not importable)" : ""}</button>)
                    : view.candidates.map((candidate) => <button className="amb-pick" type="button" key={candidate.source}
                        onClick={() => void inspect({ ...chosen, source: candidate.source })}>
                        {candidate.label}{candidate.why ? <span>{candidate.why}</span> : null}
                      </button>)}
                </div>
                <button className="linkish" type="button" onClick={startOver}>Choose a different file</button>
              </div>
            </div>
          );
        })()}

        {(p === "idle" || p === "error") && (
          <>
            <div
              className={`drop${dragging ? " over" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void inspect({ file: f, source });
              }}
            >
              <b>{source === "auto" ? "Drop any export" : `Drop the ${label.toLowerCase()} export`}</b>
              Or click to choose a CSV or Excel workbook (.xlsx)
              <div className="cols">{expects}</div>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void inspect({ file: f, source }); e.target.value = ""; }}
            />
            {p === "error" && (
              <div className="notice" style={{ marginBottom: 0 }}>
                <span className="ico">!</span>
                <div>
                  <b>{state.message}</b>
                  {state.detail.length ? (
                    <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                      {state.detail.map((d) => <li key={d}>{d}</li>)}
                    </ul>
                  ) : null}
                </div>
              </div>
            )}
          </>
        )}

        {p === "reading" && <div className="drop">Reading the import…</div>}

        {(p === "staged" || p === "committing") && <Diff plan={state.plan} />}

        {p === "staged" && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={() => commit(state.batchId, state.plan)}>
              {state.plan.unchanged
                ? "Close unchanged preview"
                : `Commit ${state.plan.diff.newRows + state.plan.diff.changedRows} rows`}
            </button>
            <button className="btn" onClick={() => discard(state.batchId)}>Discard</button>
          </div>
        )}

        {p === "committing" && <div className="dim" style={{ fontSize: 12 }}>Committing…</div>}

        {p === "done" && (
          <>
            <div className="notice info" style={{ marginBottom: 8 }}>
              <span className="ico">✓</span>
              <div>
                {state.unchanged ? (
                  <b>No changes; nothing added.</b>
                ) : <>
                <b>Committed.</b>{" "}
                {state.plan.scroll
                  ? `A ${state.plan.scroll.points}-point curve on ${state.plan.scroll.sessions} sessions is now attached to ${state.plan.scroll.round}. Read it on This round, step 3.`
                  /* An update is a write. Counting only inserts told an import
                     that had just enriched 1,401 leads that it wrote 0 rows —
                     the one screen that confirms the work said none happened. */
                  : `${joinParts([
                      state.plan.willWrite.events + state.plan.willWrite.ads
                        ? `${state.plan.willWrite.events + state.plan.willWrite.ads} rows written`
                        : "",
                      state.plan.willWrite.answers
                        ? `${state.plan.willWrite.answers} leads gained form answers`
                        : "",
                      state.plan.willWrite.unmatched
                        ? `${state.plan.willWrite.unmatched} parked`
                        : "",
                    ]) || "nothing was written"}. This batch is locked — a later import can add rows or flag a restate, never silently change these.`}
                </>}
              </div>
            </div>
            <button className="btn" onClick={() => setState({ phase: "idle" })}>Import another file</button>
          </>
        )}
      </div>
    </div>
  );
}

function Diff({ plan }: { plan: Summary }) {
  const { counts, attribution, diff, willWrite } = plan;
  return (
    <div className="diff">
      <div className="diff-h">
        <b>{plan.fileName}</b>
        {plan.review?.worksheet ? <span className="dim">Worksheet: {plan.review.worksheet}</span> : null}
        {plan.review?.profile ? <span className="dim">Profile: {plan.review.profile.name} (v{plan.review.profile.revision})</span> : null}
        <span className="dim">
          {plan.rowCount} rows · {plan.coverage.start ?? "—"} → {plan.coverage.end ?? "—"}
        </span>
      </div>

      {/* Above the counts, not below them: the counts are the symptom and this
          is the cause, and reading them in that order is the whole point. */}
      {plan.prerequisite && (
        <div className="notice" style={{ margin: "0 0 8px" }}>
          <span className="ico">!</span>
          <div>
            <b>{plan.source === "leads" ? "Import context." : "Out of order."}</b> {plan.prerequisite}
          </div>
        </div>
      )}

      <dl>
        <dt>Will write</dt>
        <dd>
          {plan.scroll ? (
            <>
              a {plan.scroll.points}-point scroll curve for <b>{plan.scroll.round}</b>
              {plan.scroll.device === "all" ? "" : ` · ${plan.scroll.device}`}
              {plan.scroll.replaces ? " · replacing the one already stored" : ""}
            </>
          ) : (
            /* ONE LIST, ONE SEPARATOR, AND "NOTHING NEW" ONLY WHEN THAT IS TRUE.
               Built by hand these ran together — an enrichment-only file printed
               "1401 leads gain form answersnothing new", because the fallback
               tested events and ads and a third kind of write had been added
               beside them. Anything countable joins the list; the fallback fires
               on the list being empty, so it cannot contradict what precedes it. */
            joinParts([
              /* Form answers arrive months after the leads do, so almost every
                 row carrying one is a lead this app already has. Written as an
                 update, not an insert — and said plainly, because "47 events"
                 beside 1,469 rows reads as a failed import otherwise. */
              willWrite.events ? `${willWrite.events} events` : "",
              willWrite.ads ? `${willWrite.ads} ads rows` : "",
              willWrite.contacts ? `${willWrite.contacts} new contacts` : "",
              willWrite.answers ? `${willWrite.answers} leads gain form answers` : "",
            ]) || "nothing new"
          )}
        </dd>

        {plan.source === "leads" && plan.leadDestinations !== undefined ? <>
          <dt>Destination rounds</dt>
          <dd>
            {plan.leadDestinations.length ? <ul aria-label="Planned Leads destination rounds">
              {plan.leadDestinations.map((round) => <li key={round.roundId}>
                <b>{round.label}</b>{round.label !== round.roundId ? <> <span className="num">({round.roundId})</span></> : null}
                {" · "}{round.count} new {round.count === 1 ? "lead" : "leads"}
                {round.declaredOutsideWindow > 0 ? <> · {round.declaredOutsideWindow} with a verified date outside the explicitly chosen round’s window</> : null}
              </li>)}
            </ul> : "No new lead events in this preview."}
            {plan.leadDestinations.length ? <p className="dim">These counts exclude skipped duplicates and rows held for review. Check the destinations before Commit.</p> : null}
          </dd>
        </> : null}

        {plan.scroll && (
          <>
            {/* The denominator, stated on the diff. Every percentage the This
                round screen draws from this file is a percentage of it, so it
                is worth reading before the import rather than after. */}
            <dt>Measured on</dt>
            <dd>
              {plan.scroll.sessions} sessions
              {plan.scroll.pageViews !== null && plan.scroll.pageViews !== plan.scroll.sessions
                ? ` — Clarity also reports ${plan.scroll.pageViews} page views, which is not the curve's base`
                : ""}
            </dd>
          </>
        )}

        {counts.matchedExact + counts.matchedAuto > 0 && (
          <>
            <dt>Matched</dt>
            <dd>
              {counts.matchedExact} exact
              {counts.matchedAuto ? ` · ${counts.matchedAuto} auto-resolved` : ""}
            </dd>
          </>
        )}

        {attribution.utm + attribution.dateWindow > 0 && (
          <>
            <dt>Attributed</dt>
            <dd>
              {attribution.utm} by ad set · {attribution.dateWindow} by date window
              {attribution.none ? ` · ${attribution.none} unattributable` : ""}
            </dd>
          </>
        )}

        {counts.duplicates > 0 && (
          <>
            <dt>Already present</dt>
            <dd>{counts.duplicates} skipped</dd>
          </>
        )}

        {/*
          Its own line, above Parked and worded differently on purpose. These
          two are the opposite outcomes of the same fact — the export named
          nobody — and collapsing them would hide which way each row went.
        */}
        {counts.unidentified > 0 && (
          <>
            <dt>Counted, not named</dt>
            <dd>{counts.unidentified} — in the round and source totals, attached to nobody</dd>
          </>
        )}

        {counts.parked > 0 && (
          <>
            <dt>Parked</dt>
            <dd>{counts.parked} — not counted anywhere</dd>
          </>
        )}
      </dl>

      {diff.restatements.length > 0 && (
        <div className="notice" style={{ margin: "8px 0 0" }}>
          <span className="ico">!</span>
          <div>
            <b>This would restate figures you have already reported.</b>
            <ul style={{ margin: "5px 0 0 16px", padding: 0 }}>
              {diff.restatements.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        </div>
      )}

      {plan.warnings.length > 0 && (
        <div className="notice" style={{ margin: "8px 0 0" }}>
          <span className="ico">!</span>
          <div>
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {plan.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        </div>
      )}

      <p className="note" style={{ margin: "8px 0 0" }}>
        Nothing has been written yet.
        {Object.keys(plan.columnMap).length ? (
          <>
            {" "}Column mapping used:{" "}
            <span className="num">
              {Object.entries(plan.columnMap).map(([f, h]) => `${h} → ${f}`).join(" · ")}
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
