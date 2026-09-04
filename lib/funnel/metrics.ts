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
 *
 * SCOPED TO THE CLIENT, which it was not.
 *
 * journey_metrics is a VOCABULARY — the set of things any client could measure.
 * client_journey_config is a CHOICE — the stages this one actually counts. The
 * read collapsed the two, so declaring `appointments` for the demo client grew
 * an Appointments dropzone on every client's Import tab, under a heading that
 * says "Stages THIS CLIENT counts". Shely's journey has six stages and
 * Appointments is not among them; the screen asserted otherwise.
 *
 * Nothing was ever imported through it and no figure moved. The cost was a
 * sentence that was not true, on the one screen whose whole job is telling you
 * what is and is not in the data.
 */
export async function loadDeclaredMetrics(clientId: string): Promise<DeclaredMetric[]> {
  const db = createReadClient();
  const [vocab, journey] = await Promise.all([
    db.from("journey_metrics")
      .select("metric, label, event_type, is_core, source, seq")
      .eq("is_core", false)
      .eq("source", "events")
      .order("seq"),
    db.from("client_journey_config").select("stage_metric").eq("client_id", clientId),
  ]);

  // A database without 0048 has no such table. That is not a fault worth
  // breaking the Import tab over — it means there are no declared metrics,
  // which is exactly what an empty list says.
  if (vocab.error) return [];

  // A journey we could not read is not a licence to offer every metric to
  // everybody — that is the bug this function had. Offer nothing instead.
  if (journey.error) return [];

  const counted = new Set(
    ((journey.data ?? []) as Array<{ stage_metric: string | null }>)
      .map((r) => r.stage_metric)
      .filter(Boolean) as string[],
  );

  return ((vocab.data ?? []) as Array<{ metric: string; label: string; event_type: string | null }>)
    .filter((r) => !!r.event_type && counted.has(r.metric))
    .map((r) => ({ metric: r.metric, label: r.label, eventType: r.event_type as string }));
}
