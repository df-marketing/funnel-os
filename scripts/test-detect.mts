/**
 * WHICH FILE IS THIS?
 *
 * One drop zone instead of five means the file has to identify itself, and the
 * cost of getting it wrong is not an error message — it is revenue filed as
 * opt-ins, with the totals still adding up.
 *
 * The required sets overlap and do not partition:
 *
 *   sales      satisfies leads' requirements      (email + event_date)
 *   leads      satisfies attendance's             (round_id + email)
 *
 * So "first source whose required fields are all present" is wrong in both
 * directions, and those two cases are the point of this file.
 */
import { detectSource } from "../lib/import/detect";
import { buildTemplate } from "../lib/import/template";
import { SOURCES, mapColumns, type SourceKey } from "../lib/import/sources";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const of = (headers: string[]) => {
  const d = detectSource(headers);
  return d.kind === "sure" ? d.source : d.kind;
};
const headersOf = (csv: string) => csv.split("\n")[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());

console.log("\neach template finds itself");
for (const k of ["ads", "leads", "attendance", "sales"] as SourceKey[]) {
  eq(`${k}`, of(headersOf(buildTemplate(k as never))), k);
}

console.log("\nthe two that overlap, which is the whole reason this is not a first-match");
{
  /* A sales export satisfies leads' requirements exactly — email and a date.
     Guessing leads here would file every purchase as an opt-in. */
  eq("a sales file is not read as leads",
    of(["event_date", "email", "phone", "product", "source", "amount"]), "sales");

  /* And a leads export carrying round_id satisfies attendance's. Guessing
     attendance would turn registrations into people who showed up. */
  eq("a leads file carrying round_id is not read as attendance",
    of(["email", "phone", "round_id", "name", "event_date", "source", "utm_campaign"]), "leads");

  eq("attendance is still attendance",
    of(["round_id", "email", "phone", "name", "source", "event_date", "minutes_watched"]), "attendance");
}

console.log("\ncurrency is not part of the column name");
{
  /* Meta writes the ad account's currency into the heading. Shely's reads SGD
     and FWD i-Care's reads MYR, and the MYR file was refused outright for
     having no spend column — the one field the ads import requires. An alias
     list is a list of the currencies somebody happened to have seen. */
  const meta = (cur: string) => ["Reporting starts", "Ad name", "Ad set name", "Campaign name",
    `Amount spent (${cur})`, "Impressions", "Reach", "Link clicks"];
  for (const cur of ["SGD", "MYR", "USD", "EUR", "IDR"]) {
    eq(`Amount spent (${cur})`, of(meta(cur)), "ads");
  }
  /* And the importer must agree with the detector, or a file is recognised and
     then refused — the worst of both. */
  const mapped = mapColumns(SOURCES.ads, meta("MYR"));
  eq("the importer also finds spend in MYR", mapped.missing, []);
}

console.log("\nit says so rather than guessing");
{
  /* Email and a date and nothing else is genuinely ambiguous: it is a valid
     leads file and a valid-enough sales file minus its money. Saying `unsure`
     costs two seconds; guessing costs a week. */
  eq("email + a date alone", of(["email", "event_date"]), "unsure");
  eq("nothing recognisable", of(["foo", "bar", "baz"]), "unknown");
  eq("an ads file with no spend column", of(["Reporting starts", "Ad name", "Impressions"]), "unknown");
}

console.log("\nClarity is found by its own marker, not by its header row");
{
  /* The scroll export's header row says Metric/Value and its spec declares no
     fields at all, so field matching can never find it. The scroll-depth table
     sits partway down the file. */
  eq("header row alone is not enough", of(["Metric", "Value"]), "unknown");
  const d = detectSource(["Metric", "Value"], ["Date range", "Scroll depth", "0%"]);
  eq("the scroll-depth label identifies it", d.kind === "sure" ? d.source : d.kind, "scroll");
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
