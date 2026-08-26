import type { SupabaseClient } from "@supabase/supabase-js";

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
      : { frozen: false, version: null, frozenAt: null, frozenBy: null, note: null, isCurrent: null, versionsAvailable: [] },
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

export const todayUtc = () => new Date().toISOString().slice(0, 10);
