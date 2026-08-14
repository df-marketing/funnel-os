/**
 * What each of the four sources is expected to contain, and how a header is
 * recognised.
 *
 * The mapping is remembered per source (import_batches.column_map) and checked
 * on every subsequent import. If Meta renames "Amount spent (SGD)" the mapping
 * breaks LOUDLY — the import is refused with the missing field named — rather
 * than importing a column of blanks that would quietly restate every ROAS.
 */

export type SourceKey = "ads" | "leads" | "attendance" | "sales";

export type FieldSpec = {
  field: string;
  required: boolean;
  aliases: string[];   // matched case/space/punctuation-insensitively
};

export type SourceSpec = {
  key: SourceKey;
  label: string;
  kind: string;
  fields: FieldSpec[];
};

const f = (field: string, required: boolean, ...aliases: string[]): FieldSpec => ({
  field,
  required,
  aliases: [field, ...aliases],
});

/**
 * email is required on the three people sources and phone is not, deliberately:
 * an export with no email column is almost certainly the wrong export, while a
 * payments or webinar file that carries a phone and no address is ordinary. A
 * phone is a full identity here — buyers exist in these files who have a number
 * and no address, and matching them on it is exactly as sound as matching an
 * email, because the same normalisation runs on both.
 */
export const SOURCES: Record<SourceKey, SourceSpec> = {
  ads: {
    key: "ads",
    label: "Ads performance",
    kind: "Meta export · CSV",
    fields: [
      f("date", true, "day", "reporting starts", "reporting_start"),
      f("campaign", false, "campaign name"),
      f("ad_set", false, "ad set name", "adset", "adset name", "ad set"),
      f("ad", false, "ad name"),
      f("spend", true, "amount spent", "amount spent (sgd)", "amount spent sgd", "cost"),
      f("impressions", false, "impr", "impression"),
      f("reach", false, "people reached"),
      f("clicks", false, "outbound clicks", "link clicks", "clicks (all)"),
    ],
  },
  leads: {
    key: "leads",
    label: "Leads",
    kind: "GoHighLevel · API or CSV",
    fields: [
      f("email", true, "email address", "contact email"),
      f("phone", false, "phone number", "mobile"),
      f("event_date", true, "created", "created at", "date created", "opt-in date", "date"),
      f("source", false, "lead source", "channel"),
      f("utm_campaign", false, "utm campaign", "utm_campaign", "campaign"),
    ],
  },
  attendance: {
    key: "attendance",
    label: "Attendance",
    kind: "Webinar platform · CSV",
    fields: [
      f("round_id", true, "session", "session id", "webinar", "round"),
      f("email", true, "email address", "attendee email"),
      f("phone", false, "phone number", "mobile", "contact number"),
      f("event_date", false, "joined at", "join time", "date"),
      f("minutes_watched", false, "minutes", "duration", "time in session"),
    ],
  },
  sales: {
    key: "sales",
    label: "Sales",
    kind: "Payments · CSV",
    fields: [
      f("event_date", true, "date", "created", "paid at", "charge date"),
      f("email", true, "email address", "customer email"),
      f("phone", false, "phone number", "mobile", "contact number"),
      f("product", true, "plan", "item", "offer"),
      f("amount", true, "total", "gross", "amount (sgd)"),
      f("refund_amount", false, "refunded", "refund", "amount refunded"),
      f("refund_date", false, "refunded at", "refund date"),
    ],
  },
};

const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Build field -> header mapping from a file's actual headers.
 * `remembered` is the previous committed mapping for this source; a header that
 * was mapped before and has vanished is reported as `broken`, not re-guessed.
 */
export function mapColumns(
  source: SourceKey,
  headers: string[],
  remembered?: Record<string, string> | null,
): { map: Record<string, string>; missing: string[]; broken: string[]; unused: string[] } {
  const spec = SOURCES[source];
  const byCanon = new Map(headers.map((h) => [canon(h), h]));
  const map: Record<string, string> = {};
  const missing: string[] = [];
  const broken: string[] = [];

  for (const fieldSpec of spec.fields) {
    // prefer the header we used last time, so the mapping is genuinely remembered
    const prev = remembered?.[fieldSpec.field];
    if (prev && byCanon.has(canon(prev))) {
      map[fieldSpec.field] = byCanon.get(canon(prev))!;
      continue;
    }
    const hit = fieldSpec.aliases.map(canon).find((a) => byCanon.has(a));
    if (hit) {
      map[fieldSpec.field] = byCanon.get(hit)!;
      // it resolved, but not to the header we remembered — that's a rename
      if (prev) broken.push(`${fieldSpec.field}: "${prev}" → "${byCanon.get(hit)}"`);
      continue;
    }
    if (prev) broken.push(`${fieldSpec.field}: "${prev}" is gone`);
    if (fieldSpec.required) missing.push(fieldSpec.field);
  }

  const used = new Set(Object.values(map).map(canon));
  const unused = headers.filter((h) => !used.has(canon(h)));

  return { map, missing, broken, unused };
}
