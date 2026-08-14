"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Resolve or dismiss one parked row.
 *
 * Every row here already has everything it needs EXCEPT a person. Typing an
 * email or phone supplies that, and the row is then replayed through the real
 * import pipeline — so it lands with the same round attribution and closing
 * credit it would have had if the export had carried the address in the first
 * place.
 *
 * The identity is always resolved against known contacts; this never invents a
 * person. Dismiss is the only lossy action, and it says so.
 */
export function UnmatchedActions({ rowId, hasGuess }: { rowId: string; hasGuess: boolean }) {
  const [busy, setBusy] = useState<null | "accept" | "assign" | "dismiss">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [identity, setIdentity] = useState("");
  const router = useRouter();

  async function act(action: "accept" | "assign" | "dismiss") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/unmatched/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rowId, action, identity }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Could not resolve."); setBusy(null); return; }
      setDone(json.outcome === "already counted" ? "already counted" : json.outcome);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
      setBusy(null);
    }
  }

  if (done) return <span className="ok-note">{done}</span>;

  return (
    <div className="row-actions">
      <input
        className="assign"
        type="text"
        value={identity}
        placeholder="email or phone"
        aria-label="Who is this row?"
        disabled={busy !== null}
        onChange={(e) => setIdentity(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && identity.trim()) act("assign"); }}
      />
      <button
        className="btn tiny primary"
        disabled={busy !== null || !identity.trim()}
        onClick={() => act("assign")}
      >
        {busy === "assign" ? "…" : "Assign"}
      </button>
      {hasGuess && (
        <button className="btn tiny" disabled={busy !== null} onClick={() => act("accept")}>
          {busy === "accept" ? "…" : "Accept guess"}
        </button>
      )}
      <button className="btn tiny" disabled={busy !== null} onClick={() => act("dismiss")}>
        {busy === "dismiss" ? "…" : "Dismiss"}
      </button>
      {error && <span className="err">{error}</span>}
    </div>
  );
}
