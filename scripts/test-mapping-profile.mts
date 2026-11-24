import assert from "node:assert/strict";
import { test } from "node:test";
import { toDate, toTimestamp } from "../lib/import/csv.ts";
import { mapColumns, SOURCES, stageSpec } from "../lib/import/sources.ts";
import {
  MappingProfileError, mappingProfileNameKey, matchMappingProfile, normalizeProfileDate,
  resolveProfileScope, validateMappingProfile,
} from "../lib/import/mapping-profile.ts";

const client = "fixture-client";
const scope = resolveProfileScope({ clientId: client, source: "leads", stageSlug: "opt-in" }, client, [{ slug: "opt-in", source: "leads" }]);
const base = {
  ...scope,
  name: " Fixture   CRM ",
  headers: ["Customer Address", "Joined On", "Campaign Name"],
  mapping: { email: "Customer Address", event_date: "Joined On" },
  rules: { dateOrder: "mdy" },
};
const lead = SOURCES.leads;
const bad = (patch: object) => assert.throws(() => validateMappingProfile({ ...base, ...patch }, scope, lead), MappingProfileError);

test("renamed aliases need confirmation; accepted profile maps only reviewed GT fields", () => {
  assert.deepEqual(mapColumns(lead, base.headers).missing, ["email", "event_date"]);
  const checked = validateMappingProfile(base, scope, lead);
  assert.equal(checked.name, "Fixture CRM");
  assert.equal(mappingProfileNameKey(" FIXTURE   ＣＲＭ "), mappingProfileNameKey(checked.name));
  assert.deepEqual(checked.mapping, base.mapping);
  assert.deepEqual(checked.rules, { dateOrder: "mdy" });
});

test("seed accidental raw or unrelated profile fields are rejected", () => {
  bad({ clientId: "other-client" });
  bad({ stageSlug: "other-stage" });
  bad({ source: "sales" });
  bad({ rows: [{ name: "Synthetic data row" }] });
  bad({ name: "" });
  bad({ name: "example@invalid.test" });
  bad({ name: "x".repeat(81) });
  bad({ mapping: { ...base.mapping, client_id: "Campaign Name" } });
  bad({ mapping: JSON.parse('{"email":"Customer Address","event_date":"Joined On","__proto__":"Campaign Name"}') });
  bad({ mapping: { email: "Customer Address" } });
  bad({ mapping: { ...base.mapping, phone: "Missing Column" } });
  bad({ mapping: { ...base.mapping, phone: "customer address" } });
  bad({ headers: [...base.headers, " Joined   ON "] });
  bad({ headers: [...base.headers, "ＣＡＭＰＡＩＧＮ　ＮＡＭＥ"] });
  bad({ headers: [...base.headers, "__proto__"] });
  bad({ headers: [...base.headers, "example@invalid.test"] });
  bad({ headers: [...base.headers, "+10000000000"] });
  bad({ headers: [...base.headers, "bad\u0000header"] });
  bad({ headers: Array.from({ length: 257 }, (_, i) => `column ${i}`) });
  bad({ rules: { dateOrder: "guess" } });
  bad({ rules: { dateOrder: "mdy", currency: "SGD" } });
});

test("scope resolves only exact client, dataset, and configured stage", () => {
  const stages = [
    { slug: "appointment", source: "stage:booked" },
    { slug: "opt-in", source: "leads" },
  ] as const;
  const check = (source: string, stageSlug: string | null, clientId = client) =>
    resolveProfileScope({ clientId, source, stageSlug }, client, stages);
  for (const [source, stageSlug] of [
    ["auto", null], ["scroll", null], ["stage:", "appointment"], ["leads", null],
    ["stage:booked", null], ["stage:booked", "opt-in"], ["stage:different", "appointment"],
  ] as const) assert.throws(() => check(source, stageSlug), MappingProfileError);
  assert.throws(() => check("leads", "opt-in", "other-client"), MappingProfileError);
  assert.throws(() => resolveProfileScope(scope, client, [stages[1], stages[1]]), MappingProfileError);
  assert.equal(check("ads", null).stageSlug, null);
  const stage = check("stage:booked", "appointment");
  assert.equal(validateMappingProfile({
    ...stage, name: "Bookings", headers: ["Session", "Email"],
    mapping: { round_id: "Session", email: "Email" }, rules: { dateOrder: "auto" },
  }, stage, stageSpec("booked", "Booked", "booked")).stageSlug, "appointment");
});

test("same header layout suggests but cannot overwrite or switch scope; collision and change are notices", () => {
  const headers = ["CAMPAIGN NAME", " Customer  Address ", "joined on"];
  const suggested = matchMappingProfile(base, scope, lead, headers);
  assert.deepEqual(suggested?.mapping, { email: "Customer  Address", event_date: "joined on" });
  assert.deepEqual(base.mapping, { email: "Customer Address", event_date: "Joined On" });
  assert.equal(matchMappingProfile(base, scope, lead, [...headers, "Unreviewed"]), null);
  assert.equal(matchMappingProfile(base, scope, lead, headers.slice(1)), null);
  assert.equal(matchMappingProfile(base, scope, lead, [...headers, "JOINED ON"]), null);
  assert.equal(matchMappingProfile({ ...base, clientId: "other-client" }, scope, lead, headers), null);
  assert.equal(matchMappingProfile({ ...base, stageSlug: "alternate" }, scope, lead, headers), null);
  assert.equal(matchMappingProfile(base, scope, SOURCES.sales, headers), null);
  assert.throws(() => validateMappingProfile(base, scope, lead, ["Unreviewed", ...headers]), /layout/);
});

test("confirmed date order resolves ambiguous dates explicitly before existing importer", () => {
  assert.equal(toDate(normalizeProfileDate("10/6/2026", "mdy")), "2026-10-06");
  assert.equal(toDate(normalizeProfileDate("10/6/2026", "dmy")), "2026-06-10");
  assert.equal(toTimestamp(normalizeProfileDate("10/6/2026 8:15:00 PM", "mdy")), "2026-10-06T12:15:00.000Z");
  assert.equal(toTimestamp(normalizeProfileDate("2026-10-06T20:15:00+08:00", "dmy")), "2026-10-06T12:15:00.000Z");
  assert.equal(toTimestamp(normalizeProfileDate("2026-02-28", "mdy")), "2026-02-28T15:59:59.000Z");
  assert.equal(normalizeProfileDate("  ", "mdy"), "  ");
  assert.equal(normalizeProfileDate("June 1, 2026", "auto"), "June 1, 2026");
  assert.equal(normalizeProfileDate("29/2/2024", "dmy"), "2024-02-29");
  for (const s of ["17/9/2026", "2/29/2026", "2026-02-30", "0/5/2026", "10/6/2026 24:00", "10/6/2026 1:60", "10/6/2026 13:00PM", "10/6/2026 14:00+08:00", "2026-10-06T20:15:00+99:00", "not a date"]) {
    assert.throws(() => normalizeProfileDate(s, "mdy"), (e) => e instanceof MappingProfileError && !e.message.includes(s));
  }
});

test("profile mode does not change legacy auto mapping and permits no format rule without a date field", () => {
  const headers = ["Email", "Created", "utm_campaign"];
  const result = mapColumns(lead, headers);
  assert.equal(result.map.ad_set, "utm_campaign");
  assert.equal(result.map.utm_campaign, "utm_campaign");
  const attendance = resolveProfileScope({ clientId: client, source: "attendance", stageSlug: null }, client, []);
  const raw = {
    ...attendance, name: "Fixture roster", headers: ["Round", "Email"], mapping: { round_id: "Round", email: "Email" },
  };
  assert.throws(() => validateMappingProfile({ ...raw, rules: { dateOrder: "dmy" } }, attendance, SOURCES.attendance), /Map a date column/);
  assert.equal(validateMappingProfile({ ...raw, rules: { dateOrder: "auto" } }, attendance, SOURCES.attendance).rules.dateOrder, "auto");
});
