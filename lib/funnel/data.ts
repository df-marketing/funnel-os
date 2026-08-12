import { createClient } from "@/lib/supabase/server";
import type { Metrics } from "./spine";

export type Client = {
  client_id: string;
  client_name: string | null;
  client_note: string | null;
  stage_count: number;
};

export type Stage = {
  client_id: string;
  stage_order: number;
  stage_name: string;
  stage_slug: string;
  compare_dimension: string | null;
  stage_metric: string | null;
  stage_rate_label: string | null;
};

export type StripCard = Stage & { value: string | null; rate: string | null };

export type Cut = {
  cut_key: string;
  cut_label: string;
  cut_sub: string | null;
  m: Metrics;
};

export type ImportStatus = {
  client_id: string | null;
  source: string;
  imported_at: string;
  coverage_start: string | null;
  coverage_end: string | null;
  row_count: number | null;
  is_stale: boolean;
  days_since: number;
};

export type UnmatchedSummary = {
  waiting: number;
  auto_resolved: number;
  revenue_held: number;
  sales_held: number;
  source_count: number;
};

export type UnmatchedReason = { reason: string; rows_waiting: number; revenue_held: number | null };

export type UnmatchedRow = {
  row_id: string;
  source: string;
  reason: string | null;
  best_guess: string | null;
  guess_method: string | null;
  confidence: string | null;
  revenue_held: number | null;
  raw_data: Record<string, unknown> | null;
};

/**
 * Everything the dashboard needs for one client, in one round-trip set.
 *
 * `error` is carried rather than thrown: before the migration has been applied
 * the views don't exist yet, and the page should say so plainly instead of
 * showing a 500.
 */
export type Dashboard = {
  clients: Client[];
  stages: Stage[];
  strip: StripCard[];
  total: Cut | null;
  baseline: Cut | null;
  byRound: Cut[];
  byAdset: Cut[];
  imports: ImportStatus[];
  unmatched: UnmatchedSummary | null;
  unmatchedReasons: UnmatchedReason[];
  unmatchedRows: UnmatchedRow[];
  error: string | null;
};

const EMPTY: Omit<Dashboard, "error"> = {
  clients: [], stages: [], strip: [], total: null, baseline: null,
  byRound: [], byAdset: [], imports: [], unmatched: null,
  unmatchedReasons: [], unmatchedRows: [],
};

export async function getDashboard(clientId?: string): Promise<Dashboard> {
  const supabase = await createClient();

  const { data: clients, error: clientErr } = await supabase
    .from("v_clients")
    .select("client_id, client_name, client_note, stage_count");

  if (clientErr) {
    return {
      ...EMPTY,
      error:
        clientErr.message.includes("does not exist") || clientErr.code === "42P01"
          ? "The database isn't set up yet — run supabase/migrations/ALL.sql in the Supabase SQL editor."
          : clientErr.message,
    };
  }
  if (!clients?.length) {
    return { ...EMPTY, error: "No clients configured. Run supabase/migrations/ALL.sql to load the schema and seed." };
  }

  const client = clients.find((c) => c.client_id === clientId) ?? clients[0];
  const id = client.client_id;

  const [stages, strip, total, baseline, byRound, byAdset, imports, unmatched, reasons, rows] =
    await Promise.all([
      supabase.from("v_journey").select("*").eq("client_id", id).order("stage_order"),
      supabase.from("v_journey_strip").select("*").eq("client_id", id).order("stage_order"),
      supabase.from("v_metrics_total").select("cut_key, cut_label, cut_sub, m").eq("client_id", id).maybeSingle(),
      supabase.from("v_metrics_baseline").select("cut_key, cut_label, cut_sub, m").eq("client_id", id).maybeSingle(),
      // Order explicitly: PostgREST doesn't guarantee a view's own ORDER BY survives.
      // Rounds read left-to-right in time; audiences by spend, biggest bet first.
      supabase
        .from("v_metrics_by_round")
        .select("cut_key, cut_label, cut_sub, m, start_date")
        .eq("client_id", id)
        .order("start_date"),
      supabase
        .from("v_metrics_by_adset")
        .select("cut_key, cut_label, cut_sub, m, sort_spend")
        .eq("client_id", id)
        .order("sort_spend", { ascending: false }),
      supabase.from("v_import_status").select("*").eq("client_id", id),
      supabase.from("v_unmatched_summary").select("*").eq("client_id", id).maybeSingle(),
      supabase.from("v_unmatched_by_reason").select("reason, rows_waiting, revenue_held").eq("client_id", id),
      supabase
        .from("unmatched_rows")
        .select("row_id, source, reason, best_guess, guess_method, confidence, revenue_held, raw_data")
        .eq("client_id", id)
        .eq("auto_resolved", false)
        .is("resolved_at", null)
        .order("revenue_held", { ascending: false })
        .limit(12),
    ]);

  return {
    clients,
    stages: stages.data ?? [],
    strip: strip.data ?? [],
    total: total.data ?? null,
    baseline: baseline.data ?? null,
    byRound: byRound.data ?? [],
    byAdset: byAdset.data ?? [],
    imports: imports.data ?? [],
    unmatched: unmatched.data ?? null,
    unmatchedReasons: reasons.data ?? [],
    unmatchedRows: rows.data ?? [],
    error: null,
  };
}
