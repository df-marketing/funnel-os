/**
 * THE SMOKE ALARM, AGAINST THE REAL FUNCTION.
 *
 * 0040 preserves unitPrice, compareDimension and rateLabel by keying on
 * stage_slug, and AcqOS assigns slugs by POSITION. So a funnel edit that moves a
 * stage moves its price onto whatever stage now holds that slug — silently, with
 * written:true and an unchanged pricesPreserved count.
 *
 * The fix is blocked (AcqOS has no stable stage identity to key on), so
 * 20260915120000 makes the failure loud instead: `slugsMoved` names every slug
 * that survived a push but is now attached to a differently-named stage.
 *
 * This runs the real RPC against a THROWAWAY client and deletes it afterwards.
 * Never shely, never a demo client anyone is looking at.
 *
 * Skips with a clear message if the migration has not been run yet, so it does
 * not fail before the SQL is applied.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CLIENT = "_slugalarm_test";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

const stage = (order: number, slug: string, name: string, extra: Record<string, unknown> = {}) => ({
  order, slug, name, metric: "leads", sourceType: "crm", sourceRef: "events.lead",
  compareDimension: null, rateLabel: null, unitPrice: null, ...extra,
});

async function push(stages: unknown[], at: string) {
  const { data, error } = await db.rpc("replace_client_journey_schema", {
    p_client_id: CLIENT, p_client_name: "Slug Alarm Test", p_stages: stages,
    p_client_note: null, p_schema_version: 1, p_generated_at: at,
  });
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}

const cleanup = async () => {
  await db.from("client_journey_config").delete().eq("client_id", CLIENT);
  await db.from("client_flags").delete().eq("client_id", CLIENT);
};

try {
  await cleanup();

  /* Push 1 — shely's real shape, including the stage that actually carries
     money. `preview` is the paid purchase and holds a unit price. */
  const first = await push([
    stage(1, "targeting", "Ad Impressions"),
    stage(2, "ads", "Landing Page Clicks"),
    stage(3, "lp", "Leads"),
    stage(4, "class", "Live Webinar Attendance"),
    stage(5, "preview", "Paid Workshop Purchase ($297)", { unitPrice: 297, rateLabel: "take-up" }),
  ], "2026-09-15T10:00:00Z");

  if (!("slugsMoved" in first)) {
    console.log("\n  SKIPPED — 20260915120000_a_push_says_when_a_slug_changed_hands.sql");
    console.log("            has not been run on this database yet.\n");
    await cleanup();
    process.exit(0);
  }

  console.log("\nthe first push has nothing to compare against");
  eq("no slugs moved", first.slugsMoved, []);
  eq("and it was written", first.written, true);

  console.log("\na push that keeps the funnel identical is silent");
  {
    const same = await push([
      stage(1, "targeting", "Ad Impressions"),
      stage(2, "ads", "Landing Page Clicks"),
      stage(3, "lp", "Leads"),
      stage(4, "class", "Live Webinar Attendance"),
      // unitPrice omitted — it must be PRESERVED, and that is not a move.
      stage(5, "preview", "Paid Workshop Purchase ($297)"),
    ], "2026-09-15T11:00:00Z");
    eq("nothing moved", same.slugsMoved, []);
    eq("but the price was preserved", same.pricesPreserved, ["preview"]);
  }

  console.log("\nTHE BUG: a stage inserted above 4 shifts every slug below it");
  {
    /* Exactly section 3 of the proposal. A new stage takes position 4, so by
       AcqOS's positional rule `class` and `preview` both slide down one — and
       `preview` now names the ATTENDANCE stage, which is about to inherit 297. */
    const shifted = await push([
      stage(1, "targeting", "Ad Impressions"),
      stage(2, "ads", "Landing Page Clicks"),
      stage(3, "lp", "Leads"),
      stage(4, "class", "Webinar Replay"),
      stage(5, "preview", "Live Webinar Attendance"),
      stage(6, "middle", "Paid Workshop Purchase ($297)"),
    ], "2026-09-15T12:00:00Z");

    const moved = shifted.slugsMoved as Array<Record<string, unknown>>;
    eq("two slugs changed hands", moved.map((m) => m.slug), ["class", "preview"]);

    const preview = moved.find((m) => m.slug === "preview")!;
    eq("preview was the purchase stage", preview.wasName, "Paid Workshop Purchase ($297)");
    eq("preview is now the attendance stage", preview.nowName, "Live Webinar Attendance");
    eq("and it inherited the price and the rate label",
      preview.inherited, ["unitPrice", "rateLabel"]);

    /* The point of the whole exercise: the push still succeeds, and the
       pre-existing field still says the price was preserved. Only slugsMoved
       says it was preserved onto the WRONG STAGE. */
    eq("the push still reports success", shifted.written, true);
    eq("and pricesPreserved still says preview — which is exactly the problem",
      shifted.pricesPreserved, ["preview"]);

    /* Confirm the damage is real in the table, not just reported. */
    const { data: rows } = await db.from("client_journey_config")
      .select("stage_order, stage_slug, stage_name, unit_price")
      .eq("client_id", CLIENT).order("stage_order");
    const attendance = rows!.find((r) => r.stage_name === "Live Webinar Attendance")!;
    const purchase = rows!.find((r) => r.stage_name === "Paid Workshop Purchase ($297)")!;
    eq("the attendance stage really did take the 297", Number(attendance.unit_price), 297);
    eq("and the purchase stage really did lose it", purchase.unit_price, null);
  }

  console.log("\nwhat it cannot do — stated, so nobody trusts it too far");
  {
    /* A rename in place. Nothing moved, but names are all this has to go on, so
       it reports one. A false positive is the honest cost of needing no
       identity from AcqOS. */
    const renamed = await push([
      stage(1, "targeting", "Ad Impressions"),
      stage(2, "ads", "Landing Page Clicks"),
      stage(3, "lp", "Leads"),
      stage(4, "class", "Webinar Replay"),
      stage(5, "preview", "Webinar Attendance"),   // renamed, not moved
      stage(6, "middle", "Paid Workshop Purchase ($297)"),
    ], "2026-09-15T13:00:00Z");
    const moved = (renamed.slugsMoved as Array<Record<string, unknown>>).map((m) => m.slug);
    eq("a rename in place reports a move that did not happen", moved, ["preview"]);
  }

  console.log("\nan older push is still refused, and reports nothing");
  {
    const stale = await push([stage(1, "targeting", "Ad Impressions")], "2026-09-15T09:00:00Z");
    eq("refused as stale", [stale.written, stale.reason], [false, "stale_push"]);
    eq("no slugsMoved on a refusal", "slugsMoved" in stale, false);
  }
} finally {
  await cleanup();
  const { count } = await db.from("client_journey_config")
    .select("client_id", { count: "exact", head: true }).eq("client_id", CLIENT);
  console.log(`\n  cleanup: ${count ?? 0} rows left for ${CLIENT}`);
  if (count) fail++;
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
