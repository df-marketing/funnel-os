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
  skippedSpend?: number;
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
        {/*
          No min/max on these.
          The obvious guard — max on the first box, min on the second — stops a
          backwards range and also greys out every date beyond the other end.
          Set the second box to 12 May and the first one's calendar opens on
          September with the entire month dead and nothing saying why. The
          picker looks broken, which is a worse fault than the one being
          prevented.
          So the range is kept sane by MOVING the other end instead of
          forbidding the click. Whichever date you set is the one you get.
        */}
        <label className="meta-pull-dates">
          <input
            type="date" value={win.since} aria-label="Pull from"
            onChange={(e) => {
              const since = e.target.value;
              setWin((w) => ({ since, until: since > w.until ? since : w.until }));
            }}
          />
          <span>→</span>
          <input
            type="date" value={win.until} aria-label="Pull to"
            onChange={(e) => {
              const until = e.target.value;
              setWin((w) => ({ until, since: until < w.since ? until : w.since }));
            }}
          />
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
          {((plan.fetched?.ad ?? 0) + (plan.fetched?.reach ?? 0)) > 0 && (
            <div className="dim meta-pull-row">
              <b>{plan.alreadyHad ?? 0}</b>
              <span>already had, unchanged</span>
            </div>
          )}

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
                {(plan.skippedSpend ?? 0) > 0 ? (
                  <> — <b>${plan.skippedSpend?.toFixed(2)}</b> of spend, counted nowhere</>
                ) : null}
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
          {/*
            Two different nothings, and saying the wrong one is a lie.
            "Meta reported nothing" means no ad ran on those days; "already in"
            means it ran and you have it. The first version said "already in"
            for both, which told somebody looking at a window their campaigns
            were switched off for that their data was safely imported.
          */}
          {p === "staged" && (plan.wouldWrite ?? 0) === 0 && (
            ((plan.fetched?.ad ?? 0) + (plan.fetched?.reach ?? 0)) === 0 ? (
              <p className="dim">
                Meta reported nothing for {plan.window?.since} to {plan.window?.until} — no ad
                spent anything on those days. That is an answer, not a failure.
              </p>
            ) : (plan.skipped?.length ?? 0) > 0 && (plan.alreadyHad ?? 0) === 0 ? (
              /*
                Meta sent rows and every one was refused. Saying "already in"
                here would be false and saying "Meta reported nothing" would send
                the reader to the ad account to look for spend that is there.
              */
              <p className="dim">
                Meta sent {(plan.fetched?.ad ?? 0) + (plan.fetched?.reach ?? 0)} rows and none of
                them could be used — see the reason above. Nothing was imported.
              </p>
            ) : (
              <p className="dim">Nothing to write — this window is already in.</p>
            )
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
