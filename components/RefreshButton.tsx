"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Force a re-read from Supabase.
 *
 * Every query on this page is cached — a figure for up to 5 minutes, the client
 * list for an hour — which is what makes a tab open in a tenth of a second. An
 * import clears that cache when it commits, so the button isn't needed for the
 * normal path.
 *
 * It's needed for the other path: rounds, prices and wipes are applied by hand
 * in the SQL editor, and nothing tells the app they happened. Without this, the
 * screen keeps showing the old number and looks exactly like SQL that didn't
 * work — so the honest fix is a way to ask, not a shorter cache that would cost
 * every page load.
 */
export function RefreshButton() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const router = useRouter();

  async function refresh() {
    setState("busy");
    try {
      const res = await fetch("/api/revalidate", { method: "POST" });
      if (!res.ok) { setState("error"); return; }
      router.refresh();
      setState("done");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("error");
    }
  }

  const label =
    state === "busy" ? "Re-reading…" :
    state === "done" ? "Up to date" :
    state === "error" ? "Failed — retry" :
    "Refresh data";

  return (
    <button
      className="btn tiny refresh"
      onClick={refresh}
      disabled={state === "busy"}
      title="Re-read everything from the database. Use this after changing rows in the SQL editor."
    >
      <span aria-hidden>↻</span> {label}
    </button>
  );
}
