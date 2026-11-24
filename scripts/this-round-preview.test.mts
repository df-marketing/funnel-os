import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
// Match the repo's extensionless TypeScript imports using Node's local fixtures.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    throw error;
  }
} });
const { buildThisRoundPreview, formatThisRoundMove, formatThisRoundValue } = await import("../lib/funnel/this-round-preview.ts");
const { projectRoundJourney } = await import("../lib/funnel/round-journey.mjs");

const clientId = "secom_smart_test";
const stage = (order: number, slug: string, metric: string, label: string, client = clientId) => ({
  client_id: client, stage_order: order, stage_slug: slug, stage_metric: metric, stage_name: label,
  stage_rate_label: null, compare_dimension: null,
});
const stages = [
  stage(2, "booked", "secom_appointments", "Book Physical Appointment"),
  stage(1, "lead-form", "secom_meta_form_leads", "Leads"),
  stage(4, "legacy-impression", "impressions", "Impressions"),
  stage(3, "sold", "secom_sale", "Sale Closed"),
  stage(8, "unrelated-stage", "secom_meta_form_leads", "Do not show", "future-fixture"),
];
const vocabulary = [
  { metric: "secom_meta_form_leads", metric_key: "formLeads", client_id: clientId, source: "ads", event_type: null, is_core: false },
  { metric: "secom_appointments", metric_key: "booked", client_id: clientId, source: "events", event_type: "appt", is_core: false },
  { metric: "secom_sale", metric_key: "sold", client_id: clientId, source: "events", event_type: "sale", is_core: false },
  { metric: "secom_meta_form_leads", metric_key: "outsider_measurement", client_id: "future-fixture", source: "ads", event_type: null, is_core: false },
];
const columns = (key: string, m: Record<string, number | null>) => ({ cut_key: key, cut_label: key, cut_sub: null, m });
const makeWindow = (round_id: string, start_date: string, end_date: string, code?: string) => ({ round_id, start_date, end_date, code });
const old = columns("0926-01", { spend: 9900, formLeads: 590, impr: 320000, booked: 0, sold: 2 });
const current = columns("1026-01", { spend: 11000, formLeads: 820, impr: 370000, booked: 12, sold: 9 });
const tie = columns("1026-02", { spend: 800, formLeads: 30, impr: 1500, booked: 0, sold: 1 });
const future = columns("2027-01-fixture", { spend: 100, formLeads: 20 });
const data = {
  stages, vocabulary, sourceKeepsSpend: true,
  roundCuts: [future, tie, old, current],
  roundSchedule: [
    makeWindow(old.cut_key, "2026-08-28", "2026-09-03"),
    makeWindow(tie.cut_key, "2026-10-06", "2026-10-15"),
    makeWindow(current.cut_key, "2026-10-06", "2026-10-12"),
    makeWindow(future.cut_key, "2027-01-02", "2027-01-04"),
  ],
  monthCuts: [
    columns("2026-09", { spend: 9900, formLeads: 590, booked: 0, impr: 320000 }),
    columns("2027-01", { spend: 100, formLeads: 20 }),
    columns("2026-10", { spend: 11800, formLeads: 850, booked: 12 }),
  ],
  baseline: old,
};
const today = "2026-11-24";
const leads = "journey:1:lead-form";

test("latest and exact selected round honor a deterministic tie-break within the active rows", () => {
  const model = buildThisRoundPreview(data, clientId, today);
  assert.deepEqual(model.eligible.map(({ cut }) => cut.cut_key), [current.cut_key, tie.cut_key, old.cut_key]);
  assert.equal(model.selected?.cut.cut_key, current.cut_key);
  assert.equal(model.previous?.cut.cut_key, tie.cut_key);
  const requested = buildThisRoundPreview(data, clientId, today, tie.cut_key);
  assert.equal(requested.selected?.cut.cut_key, tie.cut_key);
  assert.equal(requested.previous?.cut.cut_key, old.cut_key);
  const older = buildThisRoundPreview(data, clientId, today, old.cut_key);
  assert.equal(older.previous, null);
  const bad = buildThisRoundPreview(data, clientId, today, future.cut_key);
  assert.equal(bad.unavailableRound, true);
  assert.equal(bad.selected?.cut.cut_key, current.cut_key);
  const filtered = buildThisRoundPreview({ ...data, roundCuts: [old, future] }, clientId, today, tie.cut_key);
  assert.equal(filtered.unavailableRound, true);
  assert.equal(filtered.selected?.cut.cut_key, old.cut_key);
  assert.equal(filtered.previous, null);
});

test("uses the same scoped configured stage projection as By Round for current and prior", () => {
  const model = buildThisRoundPreview({ ...data, roundCuts: [current, old] }, clientId, today, undefined, leads);
  const byRound = projectRoundJourney({ stages: stages.filter((s) => s.client_id === clientId), clientId, vocabulary,
    sourceKeepsSpend: true, baseline: old, total: null, cuts: [current, old] });
  assert.deepEqual(model.roundMoves.map((row) => row.label), ["Ads Spent", "Leads", "Book Physical Appointment", "Sale Closed", "Impressions"]);
  assert.deepEqual(model.roundMoves.map((row) => row.value), byRound.rows.map((row) => byRound.cuts[0].m[row.key]));
  assert.deepEqual(model.roundMoves.map((row) => row.previous), byRound.rows.map((row) => byRound.cuts[1].m[row.key]));
  assert.equal(model.focus?.value, 820);
  assert.equal(model.focus?.previous, 590);
  assert.equal(model.focus?.baseline, 590);
  assert.equal(model.roundMoves.find((row) => row.label === "Sale Closed")?.value, null);
  const fromZero = model.roundMoves.find((row) => row.label === "Book Physical Appointment")!;
  assert.equal(fromZero.previous, 0);
  assert.equal(formatThisRoundMove(fromZero.change), "↑ from 0");
  assert.equal(formatThisRoundValue(0, "i"), "0");
  assert.equal(formatThisRoundValue(null, "i"), "—");
  assert.equal(formatThisRoundValue(0.5, "i"), "0.5");
});

test("named month follows the selected round, never newest unrelated or followed by future", () => {
  const latest = buildThisRoundPreview(data, clientId, today);
  assert.equal(latest.currentMonth?.cut_key, "2026-10");
  assert.equal(latest.previousMonth?.cut_key, "2026-09");
  assert.equal(latest.monthMoves.find((row) => row.key === leads)?.value, 850);
  assert.equal(latest.monthMoves.find((row) => row.key === leads)?.previous, 590);
  assert.equal(latest.monthMoves.find((row) => row.key === leads)?.baseline, null);
  const selectedOld = buildThisRoundPreview(data, clientId, today, old.cut_key);
  assert.equal(selectedOld.month, "2026-09");
  assert.equal(selectedOld.currentMonth?.cut_key, "2026-09");
  assert.equal(selectedOld.previousMonth, null);
  const omitted = buildThisRoundPreview({ ...data, monthCuts: [data.monthCuts[1]] }, clientId, today);
  assert.equal(omitted.currentMonth, null);
  assert.equal(omitted.previousMonth, null);
});

test("unknown date, invalid schedule, and duplicate cuts do not accidentally select another displayed copy", () => {
  const duplicated = { ...data, roundCuts: [old, old, current, tie, future], roundSchedule: [
    ...data.roundSchedule,
    makeWindow(current.cut_key, "2026-09-01", "2026-09-02"),
  ] };
  assert.deepEqual(buildThisRoundPreview(duplicated, clientId, today).eligible.map(({ cut }) => cut.cut_key), [tie.cut_key]);
  assert.equal(buildThisRoundPreview(data, clientId, "2026-02-30").selected, null);
  assert.equal(buildThisRoundPreview({ ...data, roundCuts: [future] }, clientId, today).selected, null);
});

test("unverified, wrong-client and colliding configured measurements are never mistaken for zero", () => {
  const unknown = buildThisRoundPreview({ ...data, vocabulary: null }, clientId, today, undefined, leads);
  assert.equal(unknown.vocabularyUnavailable, true);
  assert.ok(unknown.roundMoves.every((row) => row.value === null));
  const sourceRestricted = buildThisRoundPreview({ ...data, sourceKeepsSpend: false }, clientId, today);
  assert.equal(sourceRestricted.roundMoves.find((row) => row.key === leads)?.value, null);
  const collided = buildThisRoundPreview({ ...data, vocabulary: [...vocabulary, {
    metric: "duplicate_impressions", metric_key: "impr", client_id: clientId, source: "ads", event_type: null, is_core: false,
  }] }, clientId, today);
  assert.equal(collided.roundMoves.find((row) => row.label === "Impressions")?.value, null);
  assert.ok(!collided.roundMoves.some((row) => row.label === "Do not show"));
  assert.equal(formatThisRoundMove(collided.roundMoves.find((row) => row.label === "Impressions")!.change), "—");
});
