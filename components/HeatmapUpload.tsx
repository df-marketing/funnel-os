"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Attaching Clarity's heatmap to the curve it belongs to.
 *
 * The scroll curve arrives as a file and the heatmap does not — Clarity renders
 * it on screen and offers no export, so the picture is a screenshot somebody
 * takes. This is deliberately the smallest thing that can accept one: no
 * cropping, no annotation, no gallery. The heatmap is evidence for a reading
 * made from the curve, and the curve is already on the page above it.
 *
 * It sits on the run rather than the round because a round can measure two
 * landing pages on two devices, and four pictures all labelled "0726-01" are
 * four pictures nobody can tell apart.
 */
export function HeatmapUpload({ runId, path }: { runId: string; path: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function send(file: File) {
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.append("runId", runId);
    body.append("file", file);
    const res = await fetch("/api/scroll/heatmap", { method: "POST", body });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      // Said here rather than thrown away. A rejected upload with no message is
      // indistinguishable from one that silently worked.
      setError(json.error ?? `Upload failed (${res.status}).`);
      return;
    }
    router.refresh();
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/scroll/heatmap", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(json.error ?? `Removing failed (${res.status}).`); return; }
    router.refresh();
  }

  return (
    <div className="heatmap-attach">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); e.target.value = ""; }}
      />
      <button className="btn tiny" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Working…" : path ? "Replace heatmap" : "Attach Clarity heatmap"}
      </button>
      {path && !busy ? (
        <button className="btn tiny ghost" onClick={remove}>Remove</button>
      ) : null}
      {!path && !error ? (
        <span className="dim">
          Clarity has no heatmap export — screenshot the heatmap for this page and device.
        </span>
      ) : null}
      {error ? <span className="warn">{error}</span> : null}
    </div>
  );
}
