"use client";

import { useState, useTransition } from "react";
import { previewPayload, type Preview } from "@/app/actions/acqos";
import type { Wire } from "@/lib/funnel/wire";

/**
 * The AcqOS wire, from this end.
 *
 * Deliberately not a mirror of AcqOS's panel, because the wire is not
 * symmetrical and a matching pair of Send buttons would say it was. AcqOS
 * pushes the funnel shape to us; it pulls the readings back. So the inbound
 * half reports what arrived, and the outbound half shows exactly what a pull
 * returns — without pretending there is anyone here to press Send to.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Timestamps on the client's calendar, formatted the same on both sides of
 * hydration.
 *
 * Intl would be the obvious tool and is the wrong one here: the server renders
 * this first and the browser renders it again, and any disagreement between the
 * two about locale data is a hydration error on a panel whose whole job is to
 * look trustworthy. The +8 is the same rule localDay() buckets imports by, so
 * this panel and the data it describes agree about what day it is.
 */
function stamp(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 8 * 3_600_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm}`;
}

/** "2026-05" → "May 2026". Nothing is parsed that isn't already a month key. */
function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const i = Number(m) - 1;
  return MONTHS[i] ? `${MONTHS[i]} ${y}` : key;
}

export function AcqosPane({ wire, client }: { wire: Wire; client: string }) {
  const [kind, setKind] = useState<"round" | "month">("round");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, start] = useTransition();

  const { inbound, latestRound, latestMonth, frozen, frozenReadable } = wire;
  const pushed = inbound.source !== null;
  const periodKey = kind === "round" ? latestRound?.id ?? null : latestMonth;
  const canAsk = periodKey !== null;

  function check() {
    if (!periodKey) return;
    setPreview(null);
    start(async () => setPreview(await previewPayload(kind, client, periodKey)));
  }

  return (
    <>
      <div className="pane-head">
        <h1>AcqOS</h1>
        <p>
          The two apps are wired to each other. AcqOS decides what the funnel&rsquo;s steps are and
          sends the shape here; Funnel OS measures those steps and AcqOS reads the numbers back.
          This is that wire, from this end.
        </p>
      </div>

      {wire.error ? (
        <div className="notice">
          <span className="ico">!</span>
          <div>
            <b>Could not read the wire&rsquo;s bookkeeping.</b> {wire.error}
            <br />
            If this names <span className="num">v_frozen_insights</span>, migration{" "}
            <span className="num">0043</span> hasn&rsquo;t been run yet. Nothing below is missing
            because it isn&rsquo;t there — it&rsquo;s missing because the question couldn&rsquo;t be
            asked.
          </div>
        </div>
      ) : null}

      <div className="wire">
        {/* ── IN ─────────────────────────────────────────────────────────── */}
        <div className="wire-row">
          <div className="wire-dir">
            <span className="wire-arrow" aria-hidden>
              ←
            </span>
            <span className="wire-lab">In</span>
          </div>
          <div className="wire-body">
            <h3>Funnel shape</h3>
            <p>
              AcqOS owns what the steps are. A push replaces this client&rsquo;s whole funnel here,
              in one transaction — and a push carrying an older <span className="num">generatedAt</span>{" "}
              than the one on file is refused rather than allowed to undo a newer one.
            </p>
            <dl className="wire-facts">
              <dt>Source</dt>
              <dd>
                {pushed ? (
                  <b>{inbound.source}</b>
                ) : (
                  <span className="dim">set up here — AcqOS has never pushed this client</span>
                )}
              </dd>

              <dt>Version</dt>
              <dd>{inbound.version !== null ? <>v{inbound.version}</> : <span className="dim">—</span>}</dd>

              <dt>Built by AcqOS</dt>
              <dd>{stamp(inbound.generatedAt) ?? <span className="dim">—</span>}</dd>

              <dt>Stored here</dt>
              <dd>{stamp(inbound.syncedAt) ?? <span className="dim">—</span>}</dd>

              <dt>Stages</dt>
              <dd>
                {inbound.stageCount ? (
                  <>
                    {inbound.stageCount} · {inbound.firstStage} → {inbound.lastStage}
                  </>
                ) : (
                  <span className="dim">none</span>
                )}
              </dd>
            </dl>
          </div>
        </div>

        {/* ── OUT ────────────────────────────────────────────────────────── */}
        <div className="wire-row">
          <div className="wire-dir">
            <span className="wire-arrow" aria-hidden>
              →
            </span>
            <span className="wire-lab">Out</span>
          </div>
          <div className="wire-body">
            <h3>Readings</h3>
            <p>
              There is no Send button on this side, and that is on purpose:{" "}
              <b>AcqOS asks, we answer.</b> A second route by which a number could arrive is a
              second thing that can disagree with the screen. What the button below shows is the
              actual reply to the actual request, key and all — so it is a test of the wire as much
              as a preview of the payload.
            </p>

            <div className="wire-pick">
              <div className="seg">
                <button
                  type="button"
                  aria-pressed={kind === "round"}
                  disabled={!latestRound}
                  onClick={() => {
                    setKind("round");
                    setPreview(null);
                  }}
                >
                  {latestRound ? `Round ${latestRound.id}` : "No rounds"}
                </button>
                <button
                  type="button"
                  aria-pressed={kind === "month"}
                  disabled={!latestMonth}
                  onClick={() => {
                    setKind("month");
                    setPreview(null);
                  }}
                >
                  {latestMonth ? monthLabel(latestMonth) : "No months"}
                </button>
              </div>

              <button className="btn primary" onClick={check} disabled={pending || !canAsk}>
                {pending ? "Asking…" : "Check what we'd send"}
              </button>

              <span className="wire-note">
                {latestRound && kind === "round" && !latestRound.closed
                  ? "This round is still running, so the reading is provisional."
                  : "Nothing is written anywhere. This only reads."}
              </span>
            </div>

            {preview ? <PreviewBlock preview={preview} /> : null}
          </div>
        </div>

        {/* ── KEPT ───────────────────────────────────────────────────────── */}
        <div className="wire-row">
          <div className="wire-dir">
            <span className="wire-arrow" aria-hidden>
              ⏸
            </span>
            <span className="wire-lab">Kept</span>
          </div>
          <div className="wire-body">
            <h3>Frozen readings</h3>
            <p>
              A closed period keeps the reading it had when it closed. Later imports, corrections and
              late sales rightly move the live figures; they must not rewrite a result AcqOS already
              published. Re-freezing adds a version and leaves the old one readable — which is what
              makes last round&rsquo;s insight and last month&rsquo;s strategy still openable.
            </p>
            {frozen.length ? (
              <table className="plain wire-frozen">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Kind</th>
                    <th className="n">Versions</th>
                    <th className="n">Current</th>
                    <th>Frozen</th>
                  </tr>
                </thead>
                <tbody>
                  {frozen.map((f) => (
                    <tr key={`${f.kind}:${f.key}`}>
                      <td>
                        <span className="num">{f.kind === "month" ? monthLabel(f.key) : f.key}</span>
                      </td>
                      <td>{f.kind}</td>
                      <td className="n">{f.versions}</td>
                      <td className="n">v{f.currentVersion}</td>
                      <td>{stamp(f.frozenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : frozenReadable ? (
              <p className="none">
                Nothing frozen for this client yet. A reading is frozen when AcqOS closes the period,
                or by asking for it with <span className="num">POST</span> on either insight route.
              </p>
            ) : (
              <p className="none">
                Not answerable on this deployment — see above. This is not the same as nothing having
                been frozen, and the panel won&rsquo;t say it is.
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function PreviewBlock({ preview }: { preview: Preview }) {
  const good = preview.ok;
  return (
    <div className={good ? "payload" : "payload bad"}>
      <div className="payload-h">
        <span className={good ? "dot ok" : "dot miss"} aria-hidden />
        <b>
          {preview.status === 0 ? "No reply" : `HTTP ${preview.status}`}
          {good ? " — this is what AcqOS gets" : " — AcqOS would get this"}
        </b>
        <span className="spacer" />
        <span className="dim">{preview.bytes.toLocaleString("en-GB")} bytes</span>
      </div>
      <div className="payload-url">
        <span className="dim">GET</span> <span className="num">{preview.url}</span>
      </div>
      {preview.hint ? (
        <div className="notice info">
          <span className="ico">i</span>
          <div>{preview.hint}</div>
        </div>
      ) : null}
      <pre>{preview.body}</pre>
    </div>
  );
}
