/**
 * What the AcqOS wire looks like from this end.
 *
 * AcqOS has a panel headed "Send this funnel to Funnel OS", so from over there
 * the integration is a thing you can see and press. From here it was invisible:
 * a funnel arrives, the sidebar reads differently, and nothing on the screen
 * says where the new names came from or that a second system is reading these
 * numbers at all.
 *
 * The two halves are not symmetrical and the panel must not pretend they are.
 * AcqOS PUSHES the funnel shape to us and PULLS the readings back — there is no
 * endpoint on their side waiting to be sent an insight, and inventing one would
 * give a number two ways to arrive. So this loads what came in, and what is
 * available to be taken; the "send" half of the panel is a preview of exactly
 * what a pull returns.
 *
 * Everything here is bookkeeping the push already wrote. Nothing is derived and
 * nothing is guessed: a client whose funnel was never pushed reports that it was
 * never pushed, which is a true and useful thing to say.
 */

import { unstable_cache } from "next/cache";
import { createReadClient, FUNNEL_TAG } from "@/lib/supabase/read";
import { localDay } from "@/lib/import/csv";

export type WireInbound = {
  /** 'acqos' where a push wrote it; null where the journey was set up by SQL. */
  source: string | null;
  version: number | null;
  /** When AcqOS says it built the payload. */
  generatedAt: string | null;
  /** When we stored it. */
  syncedAt: string | null;
  stageCount: number;
  firstStage: string | null;
  lastStage: string | null;
};

export type WireRound = { id: string; startDate: string; endDate: string; closed: boolean };

export type WireFrozen = {
  kind: "round" | "month";
  key: string;
  versions: number;
  currentVersion: number;
  frozenAt: string;
};

export type Wire = {
  inbound: WireInbound;
  /** The newest closed round, which is the one a pull defaults to. */
  latestRound: WireRound | null;
  /** The month that round sits in, as v_metrics_by_month keys them. */
  latestMonth: string | null;
  frozen: WireFrozen[];
  /**
   * Whether the frozen list is an answer at all.
   *
   * An empty list and an unanswerable question look identical once they are both
   * `[]`, and they mean opposite things — "AcqOS has taken nothing yet" versus
   * "we cannot see what AcqOS has taken". The panel must not print the first
   * when it means the second.
   */
  frozenReadable: boolean;
  /** Set when a read failed. The panel says so rather than showing an empty one. */
  error: string | null;
};

type ConfigRow = {
  stage_order: number;
  stage_name: string;
  schema_source: string | null;
  schema_version: number | null;
  generated_at: string | null;
  synced_at: string | null;
};

type RoundRow = { round_id: string; start_date: string; end_date: string };

type FrozenRow = {
  period_kind: string;
  period_key: string;
  versions: number;
  current_version: number;
  frozen_at: string;
};

/**
 * Cached for a minute, not the five the rest of the chrome gets.
 *
 * This panel is the thing someone opens to answer "did the push land?", and an
 * answer that is five minutes stale is worse than no answer — it reads as a
 * failed push and sends someone to look at AcqOS. A minute is short enough that
 * waiting it out is quicker than diagnosing it, and Refresh data clears it now.
 */
export const loadWire = unstable_cache(
  async (clientId: string): Promise<Wire> => {
    const db = createReadClient();
    const [config, rounds, frozen] = await Promise.all([
      db
        .from("client_journey_config")
        .select("stage_order, stage_name, schema_source, schema_version, generated_at, synced_at")
        .eq("client_id", clientId)
        .order("stage_order"),
      db
        .from("rounds")
        .select("round_id, start_date, end_date")
        .eq("client_id", clientId)
        .order("end_date", { ascending: false }),
      db
        .from("v_frozen_insights")
        .select("period_kind, period_key, versions, current_version, frozen_at")
        .eq("client_id", clientId)
        .order("frozen_at", { ascending: false }),
    ]);

    /**
     * A failed read is reported, never folded into an empty result — and never
     * allowed to blank the reads that worked.
     *
     * v_frozen_insights is new in 0043, so a deployment whose migration has not
     * been run yet gets a PostgREST error for that one read alone. Swallowing it
     * would print "nothing frozen yet" under a client that has frozen three
     * periods, which is the one wrong answer this panel exists to avoid. Failing
     * the whole load instead would blank the inbound half, which is the second.
     * Each read stands or falls on its own and the message names which fell.
     */
    const failed = [
      config.error && `client_journey_config: ${config.error.message}`,
      rounds.error && `rounds: ${rounds.error.message}`,
      frozen.error && `v_frozen_insights: ${frozen.error.message}`,
    ].filter(Boolean) as string[];

    const stages = (config.data ?? []) as ConfigRow[];
    const roundRows = (rounds.data ?? []) as RoundRow[];
    const today = localDay(new Date().toISOString());

    // The newest CLOSED round is what a pull answers with by default, so that is
    // the one named here. Falling back to the newest round of any kind keeps a
    // client mid-round from reading as a client with no rounds.
    const latest =
      roundRows.find((r) => r.end_date < today) ?? roundRows[0] ?? null;

    return {
      inbound: {
        // Every row of one client's journey carries the same push metadata —
        // replace_client_journey_schema writes them in one transaction — so the
        // first row is the whole answer.
        source: stages[0]?.schema_source ?? null,
        version: stages[0]?.schema_version ?? null,
        generatedAt: stages[0]?.generated_at ?? null,
        syncedAt: stages[0]?.synced_at ?? null,
        stageCount: stages.length,
        firstStage: stages[0]?.stage_name ?? null,
        lastStage: stages.length ? stages[stages.length - 1].stage_name : null,
      },
      latestRound: latest
        ? {
            id: latest.round_id,
            startDate: latest.start_date,
            endDate: latest.end_date,
            closed: latest.end_date < today,
          }
        : null,
      latestMonth: latest ? latest.end_date.slice(0, 7) : null,
      frozen: ((frozen.data ?? []) as FrozenRow[])
        .filter((f) => f.period_kind === "round" || f.period_kind === "month")
        .map((f) => ({
          kind: f.period_kind as "round" | "month",
          key: f.period_key,
          versions: f.versions,
          currentVersion: f.current_version,
          frozenAt: f.frozen_at,
        })),
      frozenReadable: !frozen.error,
      error: failed.length ? failed.join(" · ") : null,
    };
  },
  ["funnel-wire"],
  { tags: [FUNNEL_TAG], revalidate: 60 },
);
