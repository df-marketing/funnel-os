"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * PULL NOW.
 *
 * The same two steps as dropping a file — read the diff, then commit — because
 * it is the same act: numbers arriving from outside and restating figures
 * somebody may already have reported. A button that wrote on the first press
 * would be the one place in this app where that is not true.
 *
 * It says what it will not do as prominently as what it will. Operators press a
 * button that reaches a live ad account more readily when the screen tells them
 * it only reads, and the honest reason it only reads is that spend, impressions,
 * clicks and reach are the whole surface — leads, sales and everything below the
 * ad belong to the CRM and the payments file.
 */

type Result = {
  ok: boolean;
  error?: string;
  note?: string;
  committed?: boolean;
  window?: { since: string; until: string };
  fetched?: { ad: number; reach: number };
  wouldWrite?: number;
  alreadyHad?: number;
  written?: number;
  rounds?: string[];
  skipped?: Array<{ campaign: string | null; date: string | null; reason: string }>;
  reachWithheld?: number;
  anyFailed?: boolean;
};

type State =
  | { phase: "idle" }
  | { phase: "reading" }
  | { phase: "staged"; plan: Result }
  | { phase: "committing"; plan: Result }
  | { phase: "done"; plan: Result }
  | { phase: "error"; message: string };

/** Yesterday and today, in the browser's own reckoning. */
const defaultWindow = () => {
  const d = (n: number) => {
    const x = new Date();
    x.setDate(x.getDate() - n);
    return x.toISOString().slice(0, 10);
  };
  return { since: d(1), until: d(0) };
};

const REASONS: Record<string, string> = {
  no_round_for_campaign: "no round covers these dates and the campaign names none",
  measured_nothing: "the ad ran but spent nothing and was seen by nobody",
  no_date_on_row: "Meta sent no date",
};

export function MetaPullButton({ client }: { client: string }) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const [win, setWin] = useState(defaultWindow);
  const router = useRouter();

  async function call(commit: boolean) {
    setState(commit ? { phase: "committing", plan: (state as { plan: Result }).plan } : { phase: "reading" });
    try {
      const res = await fetch("/api/meta-pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: client, ...win, commit }),
      });
      const body = (await res.json()) as Result;
      if (!res.ok || !body.ok) {
        setState({ phase: "error", message: body.note ?? friendly(body.error) });
        return;
      }
      if (commit) {
        setState({ phase: "done", plan: body });
        router.refresh();
      } else {
        setState({ phase: "staged", plan: body });
      }
    } catch {
      setState({ phase: "error", message: "We couldn't reach Meta just now — try again in a moment." });
    }
  }

  const p = state.phase;
  const plan = "plan" in state ? state.plan : null;

  return (
    <div className="meta-pull">
      <div className="meta-pull-head">
        <button
          className="btn"
          disabled={p === "reading" || p === "committing"}
          onClick={() => call(false)}
        >
          {p === "reading" ? "Reading Meta…" : "Pull from Meta"}
        </button>
        <label className="meta-pull-dates">
          <input type="date" value={win.since} max={win.until}
                 onChange={(e) => setWin({ ...win, since: e.target.value })} />
          <span>→</span>
          <input type="date" value={win.until} min={win.since}
                 onChange={(e) => setWin({ ...win, until: e.target.value })} />
        </label>
      </div>

      <p className="dim meta-pull-hint">
        Reads only. It never changes anything on the ad account, and it writes just
        spend, impressions, clicks and reach — leads and sales keep coming from the
        files below. Nothing lands until you press commit.
      </p>

      {p === "error" && (
        <div className="notice warn"><span className="ico">!</span><div>{state.message}</div></div>
      )}

      {(p === "staged" || p === "committing" || p === "done") && plan && (
        <div className="meta-pull-diff">
          <div className="meta-pull-row">
            <b>{plan.committed ? (plan.written ?? 0) : (plan.wouldWrite ?? 0)}</b>
            <span>
              {plan.committed
                ? `row${(plan.written ?? 0) === 1 ? "" : "s"} written`
                : `row${(plan.wouldWrite ?? 0) === 1 ? "" : "s"} to write`}
              {plan.rounds?.length ? ` · ${plan.rounds.join(", ")}` : null}
            </span>
          </div>

          {/*
            The count that stops a pull which found nothing new from reading as a
            pull that failed. Nothing to write IS the right answer over a window
            already imported, and without saying so the screen looks broken.
          */}
          <div className="dim meta-pull-row">
            <b>{plan.alreadyHad ?? 0}</b>
            <span>already had, unchanged</span>
          </div>

          {(plan.reachWithheld ?? 0) > 0 && (
            <div className="dim meta-pull-row">
              <b>{plan.reachWithheld}</b>
              <span>reach rows held back — these rounds are already measured, and
                    reach counts people, so a second row would be added to a figure
                    that already covers them</span>
            </div>
          )}

          {plan.skipped?.length ? (
            <div className="dim meta-pull-row">
              <b>{plan.skipped.length}</b>
              <span>
                not written —{" "}
                {[...new Set(plan.skipped.map((s) => s.reason))]
                  .map((r) => REASONS[r] ?? r)
                  .join("; ")}
              </span>
            </div>
          ) : null}

          {plan.anyFailed && (
            <div className="notice warn"><span className="ico">!</span>
              <div>Part of this pull failed, so the figures above are incomplete.</div></div>
          )}

          {p === "staged" && (plan.wouldWrite ?? 0) > 0 && (
            <button className="btn primary" onClick={() => call(true)}>
              Commit {plan.wouldWrite} row{plan.wouldWrite === 1 ? "" : "s"}
            </button>
          )}
          {p === "staged" && (plan.wouldWrite ?? 0) === 0 && (
            <p className="dim">Nothing to write — this window is already in.</p>
          )}
          {p === "committing" && <p className="dim">Committing…</p>}
          {p === "done" && <p className="dim">Done. The figures above have been re-read.</p>}
        </div>
      )}
    </div>
  );
}

const friendly = (code?: string) =>
  code === "no_meta_ad_account"
    ? "No Meta ad account is set for this client yet."
    : code === "cooldown"
      ? "Just pulled — give it a few seconds."
      : "We couldn't pull the latest numbers just now — please try again in a moment.";
