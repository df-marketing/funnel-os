import { SOURCES, type SourceKey } from "./sources";

/**
 * A worked example for every field the importer knows about.
 *
 * Generated from SOURCES rather than typed out, so a template can never drift
 * from what the importer actually accepts — the question "what format does this
 * want?" is answered by a file that is correct by construction.
 */
const EXAMPLE: Record<string, [string, string]> = {
  // ads
  date:            ["2026-08-01", "2026-08-02"],
  campaign:        ["Shely_Aug_Webinar", "Shely_Aug_Webinar"],
  ad_set:          ["Cold_Broad", "Cold_CourseCreators"],
  ad:              ["Video_A_Hook1", "Static_B_Testimonial"],
  spend:           ["412.50", "388.20"],
  impressions:     ["18400", "16920"],
  reach:           ["14200", "13050"],
  clicks:          ["286", "241"],
  // leads
  email:           ["ava.tan@example.sg", "ben.lim@example.sg"],
  phone:           ["+6591234567", "91234568"],
  event_date:      ["2026-08-01", "2026-08-02"],
  source:          ["Paid Ads", "Organic"],
  utm_campaign:    ["DF_SG_Preview_Sprint1_0526_02", ""],
  // attendance
  round_id:        ["0826-01", "0826-01"],
  minutes_watched: ["74", "12"],
  // sales
  product:         ["preview", "middle"],
  amount:          ["297.00", "1197.00"],
  refund_amount:   ["", "0.00"],
  refund_date:     ["", ""],
};

/** Fields whose meaning isn't obvious from the name alone. */
const NOTE: Partial<Record<SourceKey, string[]>> = {
  ads: [
    "ad_set is what bridges spend to people: it must match the leads file's ad_set (GoHighLevel's utm_term) exactly.",
  ],
  leads: [
    "ad_set comes from GoHighLevel's utm_term and must match an ad_set in the ads file, or the lead falls back to date-window attribution. ad comes from utm_content.",
    "phone may be local or E.164 — both are normalised. Leave blank rather than writing 'n/a'.",
  ],
  attendance: [
    "round_id must be a round that already exists, e.g. 0826-01.",
    "event_date with a time is better than a date alone — it decides which class gets the closing credit.",
  ],
  sales: [
    "product must be 'preview' or 'middle'.",
    "Leave refund_amount and refund_date blank for a normal sale. Filling them in later restates the round, and the diff will warn you before it does.",
  ],
};

/**
 * Where a field means something different depending on the file it's in.
 *
 * Attendance is the one that matters: the note tells you a timestamp beats a
 * bare date because it decides the closing credit, so the example has to show a
 * timestamp — an example that contradicts its own advice teaches the wrong habit.
 */
const PER_SOURCE: Partial<Record<SourceKey, Record<string, [string, string]>>> = {
  attendance: {
    event_date: ["2026-08-05 20:04", "2026-08-05 20:31"],
  },
  sales: {
    event_date: ["2026-08-05 21:12", "2026-08-06 09:40"],
  },
};

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function buildTemplate(source: SourceKey): string {
  const spec = SOURCES[source];
  const fields = spec.fields.map((f) => f.field);
  const override = PER_SOURCE[source] ?? {};

  const header = fields.map(cell).join(",");
  const rows = [0, 1].map((i) =>
    fields.map((f) => cell((override[f] ?? EXAMPLE[f])?.[i] ?? "")).join(","),
  );

  // Comment lines start with # and are dropped as blank-ish by the parser's own
  // header handling only if removed first, so they go after the data as a legend
  // the user reads in a spreadsheet and deletes along with the example rows.
  const required = spec.fields.filter((f) => f.required).map((f) => f.field);
  const legend = [
    "",
    `# ${spec.label} — ${spec.kind}`,
    `# Required: ${required.join(", ")}`,
    `# Optional: ${fields.filter((f) => !required.includes(f)).join(", ") || "none"}`,
    "# Delete the two example rows and these comment lines before importing.",
    "# Column order does not matter. Extra columns are ignored and reported back to you.",
    ...(NOTE[source] ?? []).map((n) => `# ${n}`),
  ];

  return [header, ...rows, ...legend].join("\n") + "\n";
}
