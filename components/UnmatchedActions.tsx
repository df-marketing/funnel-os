"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Resolve or dismiss one parked row.
 *
 * Accepting applies the system's best guess — it never invents a contact. If the
 * guess doesn't land on a known person the server refuses and says so, because
 * the alternative is guessing revenue into a round.
 */
export function UnmatchedActions({ rowId, hasGuess }: { rowId: string; hasGuess: boolean }) {
  const [busy, setBusy] = useState<null | "accept" | "dismiss">(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function act(action: "accept" | "dismiss") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/unmatched/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rowId, action }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Could not resolve."); setBusy(null); return; }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
      setBusy(null);
    }
  }

  return (
    <div className="row-actions">
      {hasGuess && (
        <button className="btn tiny primary" disabled={busy !== null} onClick={() => act("accept")}>
          {busy === "accept" ? "…" : "Accept"}
        </button>
      )}
      <button className="btn tiny" disabled={busy !== null} onClick={() => act("dismiss")}>
        {busy === "dismiss" ? "…" : "Dismiss"}
      </button>
      {error && <span className="err">{error}</span>}
    </div>
  );
}
