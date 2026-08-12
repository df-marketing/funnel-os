"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A <details> that remembers whether you closed it.
 *
 * Open by default, because someone who has never used this needs the walkthrough
 * and there's no reliable way to tell a newcomer from a regular — the seeded
 * import history makes every client look experienced. Closing it sticks, so it
 * asks once rather than every morning.
 *
 * The server renders it open and the stored state is applied on mount: a reader
 * who collapsed it sees a brief flash, which is the cheap side of the trade
 * against a hydration mismatch.
 */
export function Collapsible({
  id, summary, children,
}: {
  id: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const key = `funnel-os:${id}`;

  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null && ref.current) ref.current.open = stored === "open";
    } catch {
      // Private mode or blocked storage: leave it open, which is the safe default.
    }
  }, [key]);

  return (
    <details
      ref={ref}
      className="how"
      open
      onToggle={(e) => {
        try {
          localStorage.setItem(key, e.currentTarget.open ? "open" : "closed");
        } catch {
          // Nothing to do — the panel still works, it just won't be remembered.
        }
      }}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
