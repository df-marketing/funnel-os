/**
 * The measurements this database knows about, beyond the six built in.
 *
 * 0048 moved the vocabulary out of the source code and into journey_metrics, so
 * the list of things a client can measure is now a query rather than a constant.
 * This is the read for the screens that have to offer one — today the Import
 * tab, which cannot know in advance how many files a client has to drop.
 *
 * Only the declared ones. The core six have their own import paths, their own
 * arithmetic in fo_metrics and their own place in the straight line, and
 * offering a second dropzone for attendance would be offering the same file
 * twice.
 */

import { createReadClient } from "@/lib/supabase/read";

export type DeclaredMetric = {
  metric: string;
  label: string;
  /** The event_type each imported row becomes. */
  eventType: string;
};

/**
 * Not cached, and it is three rows at most.
 *
 * A declared metric appears the moment someone inserts it, and the screen that
 * shows it is the one you open to check whether it worked — the same reasoning
 * the AcqOS panel is uncached for.
 */
export async function loadDeclaredMetrics(): Promise<DeclaredMetric[]> {
  const db = createReadClient();
  const { data, error } = await db
    .from("journey_metrics")
    .select("metric, label, event_type, is_core, source, seq")
    .eq("is_core", false)
    .eq("source", "events")
    .order("seq");

  // A database without 0048 has no such table. That is not a fault worth
  // breaking the Import tab over — it means there are no declared metrics,
  // which is exactly what an empty list says.
  if (error) return [];

  return ((data ?? []) as Array<{ metric: string; label: string; event_type: string | null }>)
    .filter((r) => !!r.event_type)
    .map((r) => ({ metric: r.metric, label: r.label, eventType: r.event_type as string }));
}
