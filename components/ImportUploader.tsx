"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Summary = {
  source: string; fileName: string; rowCount: number;
  coverage: { start: string | null; end: string | null };
  columnMap: Record<string, string>; unusedColumns: string[];
  counts: { matchedExact: number; matchedAuto: number; newContacts: number; parked: number; duplicates: number };
  attribution: { utm: number; dateWindow: number; none: number };
  diff: { newRows: number; changedRows: number; restatements: string[] };
  warnings: string[];
  prerequisite: string | null;
  willWrite: { contacts: number; events: number; ads: number; unmatched: number; refunds: number };
};

type State =
  | { phase: "idle" }
  | { phase: "reading" }
  | { phase: "staged"; batchId: string; plan: Summary }
  | { phase: "committing"; batchId: string; plan: Summary }
  | { phase: "done"; plan: Summary }
  | { phase: "error"; message: string; detail: string[] };

export function ImportUploader({
  source, label, kind, client, expects,
}: {
  source: string; label: string; kind: string; client: string; expects: string;
}) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function upload(file: File) {
    setState({ phase: "reading" });
    const body = new FormData();
    body.append("file", file);
    body.append("source", source);
    body.append("client", client);

    try {
      const res = await fetch("/api/import/preview", { method: "POST", body });
      const json = await res.json();
      if (!res.ok) {
        setState({ phase: "error", message: json.error ?? "Import failed.", detail: json.detail ?? [] });
        return;
      }
      setState({ phase: "staged", batchId: json.batchId, plan: json.plan });
    } catch {
      setState({ phase: "error", message: "Could not reach the server.", detail: [] });
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
      setState({ phase: "done", plan });
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
                if (f) upload(f);
              }}
            >
              <b>Drop the {label.toLowerCase()} export</b>
              Or click to choose a CSV
              <div className="cols">{expects}</div>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }}
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

        {p === "reading" && <div className="drop">Reading, matching and attributing…</div>}

        {(p === "staged" || p === "committing") && <Diff plan={state.plan} />}

        {p === "staged" && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={() => commit(state.batchId, state.plan)}>
              Commit {state.plan.diff.newRows + state.plan.diff.changedRows} rows
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
                <b>Committed.</b> {state.plan.willWrite.events + state.plan.willWrite.ads} rows written,{" "}
                {state.plan.willWrite.unmatched} parked. This batch is locked — a later import can add
                rows or flag a restate, never silently change these.
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
            <b>Out of order.</b> {plan.prerequisite}
          </div>
        </div>
      )}

      <dl>
        <dt>Will write</dt>
        <dd>
          {willWrite.events ? `${willWrite.events} events` : null}
          {willWrite.ads ? `${willWrite.ads} ads rows` : null}
          {willWrite.contacts ? ` · ${willWrite.contacts} new contacts` : ""}
          {!willWrite.events && !willWrite.ads ? "nothing new" : ""}
        </dd>

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
        Nothing has been written yet. Column mapping used:{" "}
        <span className="num">
          {Object.entries(plan.columnMap).map(([f, h]) => `${h} → ${f}`).join(" · ")}
        </span>
      </p>
    </div>
  );
}
