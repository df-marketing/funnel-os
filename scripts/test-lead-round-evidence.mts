import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, writeCsv } from "../lib/import/csv.ts";
import {
  inspectLeadOptInDate, inspectLeadRoundTags, leadDateBlock,
} from "../lib/import/lead-round-evidence.ts";

test("raw mixed tags report 93/97, 26 conflicts, 67 unequivocal, and four missing", () => {
  const headers = ["Synthetic Row", "Contact Tags", "Opt-in date"];
  const rows = Array.from({ length: 97 }, (_, i) => ({
    "Synthetic Row": `fixture-${i}`,
    "Contact Tags": i < 67 ? "round: 1126-01"
      : i < 93 ? (i % 2 ? "early 1026-01,round: 1126-01" : "round: 1126-01,next 1226-02") : "",
    "Opt-in date": "",
  }));
  const file = parseCsv(writeCsv(headers, rows));
  const inspected = inspectLeadRoundTags(file.headers, file.rows);
  assert.ok(inspected);
  assert.equal(inspected.rows, 97);
  assert.deepEqual(inspected.dominant, { code: "1126-01", count: 93, unambiguousCount: 67 });
  assert.equal(inspected.withRoundCode, 93);
  assert.equal(inspected.withoutRoundCode, 4);
  assert.equal(inspected.blankTagRows, 4);
  assert.equal(inspected.multiTagRows, 26);
  assert.equal(inspected.ambiguousRoundRows, 26);
  for (const raw of ["fixture-4", "round: ", "early ", "next "]) assert.ok(!JSON.stringify(inspected).includes(raw));
  assert.deepEqual(inspectLeadOptInDate(file.rows, "Opt-in date"), { header: "Opt-in date", blankRows: 97 });
});

test("counts a repeated code once per row, distinguishes multitag from multiround", () => {
  const result = inspectLeadRoundTags(["Tags"], [
    { Tags: "1126-01; confirmed 1126-01" }, { Tags: "1126-01 | generic tag" },
    { Tags: "1111 generic tag" }, { Tags: "2026-11-24, invalid 1326-01, tracking_1126-01_X" },
    { Tags: "1126-01" },
  ]);
  assert.ok(result);
  assert.equal(result.tagColumn, "verified");
  assert.deepEqual(result.dominant, { code: "1126-01", count: 3, unambiguousCount: 3 });
  assert.equal(result.withoutRoundCode, 2);
  assert.equal(result.multiTagRows, 3);
  assert.equal(result.ambiguousRoundRows, 0);
});

test("a majority only in ambiguous rows or a tie is not a dominant suggestion", () => {
  const result = inspectLeadRoundTags(["Tags"], [
    { Tags: "1126-01; 1026-01" }, { Tags: "1126-01; 1026-01" },
    { Tags: "1126-01" }, { Tags: "1026-01" },
  ]);
  assert.ok(result);
  assert.equal(result.ambiguousRoundRows, 2);
  assert.equal(result.dominant, null);
  assert.equal(result.topCodes[0].count, 3);
});

test("never combines competing Tags columns or reads unrelated metadata columns", () => {
  const conflict = inspectLeadRoundTags(["Tags", "Contact Tag"], [{ Tags: "1126-01", "Contact Tag": "1026-01" }]);
  assert.equal(conflict?.tagColumn, "ambiguous");
  assert.equal(conflict?.dominant, null);
  assert.equal(inspectLeadRoundTags(["Synthetic notes"], [{ "Synthetic notes": "1126-01" }]), null);
  assert.equal(inspectLeadRoundTags(["Tags"], []), null);
});

test("a date is required; a new mapping is validated by Preview without inheriting another column's blanks", () => {
  assert.match(leadDateBlock(undefined, undefined) ?? "", /real opt-in date/);
  const autoDate = inspectLeadOptInDate([{ Created: "" }, { Created: "2026-11-24" }], "Created");
  assert.match(leadDateBlock(autoDate, "Created") ?? "", /1 row is missing/);
  assert.equal(leadDateBlock(autoDate, "Verified Date"), null);
  assert.equal(leadDateBlock(inspectLeadOptInDate([{ Created: "2026-11-24" }], "Created"), "Created"), null);
});
