import type { SupabaseClient } from "@supabase/supabase-js";
import { localDay } from "../import/csv";

export type PeriodKind = "round" | "month";
export type FrozenMode = "prefer" | "only" | "never";

export type StoredInsight = {
  version: number;
  is_current: boolean;
  payload: Record<string, unknown>;
  frozen_at: string;
  frozen_by: string | null;
  note: string | null;
};

export function freezeMode(value: string | null): FrozenMode | null {
  if (value === null || value === "" || value === "prefer") return "prefer";
  return value === "only" || value === "never" ? value : null;
}

export function insightWithSnapshot(payload: Record<string, unknown>, insight: StoredInsight | null, versions: number[]) {
  return {
    ...payload,
    snapshot: insight
      ? {
          frozen: true, version: insight.version, frozenAt: insight.frozen_at,
          frozenBy: insight.frozen_by, note: insight.note, isCurrent: insight.is_current,
          versionsAvailable: versions,
        }
      // Live, but the versions are still listed. A caller reading frozen=never
      // is entitled to know a stored copy exists and differs from what it just
      // got; an empty list here would say there was nothing to compare against.
      : { frozen: false, version: null, frozenAt: null, frozenBy: null, note: null, isCurrent: null, versionsAvailable: versions },
  };
}

export async function snapshotsFor(
  db: SupabaseClient, clientId: string, kind: PeriodKind, key: string,
): Promise<StoredInsight[]> {
  const { data, error } = await db.from("period_insights")
    .select("version, is_current, payload, frozen_at, frozen_by, note")
    .eq("client_id", clientId).eq("period_kind", kind).eq("period_key", key)
    .order("version");
  if (error) throw new Error(`period_insights: ${error.message}`);
  return (data ?? []) as StoredInsight[];
}

export const versionsOf = (rows: StoredInsight[]) => rows.map((row) => row.version);

export function chosenSnapshot(rows: StoredInsight[], mode: FrozenMode, version: number | null) {
  if (version !== null) return rows.find((row) => row.version === version) ?? null;
  return mode === "never" ? null : rows.find((row) => row.is_current) ?? null;
}

/** Pure guard: a completed calendar day is freezable; today and after are not. */
export function isClosedDay(endDate: string, today: string) {
  return endDate < today;
}

/** A month containing today is still open, even if its past days have data. */
export function isClosedMonth(from: string, to: string, today: string) {
  return today < from || today > to;
}

/**
 * Today, on the client's calendar rather than the server's.
 *
 * This was UTC, and UTC is eight hours behind the day these periods are named
 * in. At 00:30 on 1 September in Singapore, a UTC clock still reads 31 August —
 * so freezing August was refused as "the month contains today", which is the
 * exact hour a monthly job would run. A round that finished yesterday was
 * refused the same way for the same eight hours.
 *
 * localDay() is the app's existing answer to this and is what the importer
 * buckets by, so the freeze guard and the data it is guarding now agree about
 * what day it is.
 */
export const todayLocal = () => localDay(new Date().toISOString());
