/**
 * What each of the four sources is expected to contain, and how a header is
 * recognised.
 *
 * The mapping is remembered per source (import_batches.column_map) and checked
 * on every subsequent import. If Meta renames "Amount spent (SGD)" the mapping
 * breaks LOUDLY — the import is refused with the missing field named — rather
 * than importing a column of blanks that would quietly restate every ROAS.
 */

export type SourceKey = "ads" | "leads" | "attendance" | "sales" | "scroll";

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
  /**
   * A source the client may simply not use.
   *
   * The header calls out every source that has never been imported, because
   * absence was passing as freshness. Scroll is different in kind: no round has
   * to have a Clarity export, and a permanent "Landing page scroll never
   * imported" beside four real warnings teaches people to ignore all five.
   * It is offered on the Import tab and it does not nag.
   */
  optional?: boolean;
  /**
   * The event_type each row becomes, for a source that imports people doing a
   * thing. Absent on ads and scroll, which are not people.
   *
   * This is what makes a declared metric importable without new code: 0048 put
   * the vocabulary in a table, and a stage source is that table's row wearing
   * the shape the attendance import already had.
   */
  eventType?: string;
  /** What the dropzone says the file should contain, when field names won't do. */
  expects?: string;
  /** False where a blank template makes no sense — see template.ts. */
  template?: false;
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
      /**
       * The far end of a period-level export's window.
       *
       * A report with no day breakdown carries one row per ad set for the whole
       * period, and "Reporting starts" is then the START of that period, not the
       * day the spend happened. Without this the batch records a file covering
       * 1-31 May as covering 1 May only, and the staleness flag — which compares
       * coverage against the rounds — fires immediately on a file that is
       * complete.
       */
      f("date_end", false, "reporting ends", "reporting_end", "date stop", "day stop"),
      f("campaign", false, "campaign name"),
      f("ad_set", false, "ad set name", "adset", "adset name", "ad set"),
      f("ad", false, "ad name"),
      f("spend", true, "amount spent", "amount spent (sgd)", "amount spent sgd", "cost"),
      f("impressions", false, "impr", "impression"),
      f("reach", false, "people reached"),
      f("clicks", false, "outbound clicks", "link clicks", "clicks (all)"),
      /**
       * Which platform the money was spent on — meta, google, tiktok.
       *
       * Optional, because no export we have carries it: Meta's report doesn't
       * name Meta anywhere in the file. A file that omits it is treated as Meta
       * and the Import screen says so, rather than the database quietly
       * defaulting and nobody being told. See ASSUMED_CHANNEL in pipeline.ts.
       */
      f("channel", false, "platform", "network", "ad platform", "source platform"),
    ],
  },
  leads: {
    key: "leads",
    label: "Leads",
    kind: "GoHighLevel · API or CSV",
    fields: [
      f("email", true, "email address", "contact email"),
      f("phone", false, "phone number", "mobile"),
      /**
       * WHICH ROUND'S LIST THIS ROW CAME FROM — believed over any guess.
       *
       * Optional, because a raw GoHighLevel export does not have it. Read where
       * it does, because a per-round Registration List is not evidence about a
       * round, it IS the round: the export is one file per round and the row is
       * on it.
       *
       * Without this the round was inferred, and the inference is wrong in a way
       * no date can fix — PEOPLE REGISTER BEFORE THE ADS RUN. On Shely's own
       * lists, 74 of 0826-01's 97 registrants signed up while 0726-04 was still
       * advertising, so a date window filed them under the previous round. One
       * list lost two thirds of its people that way.
       *
       * utm_campaign stays ahead of it, because a lead who clicked a specific
       * round's ad is evidence about that ad. This answers the case where there
       * is no UTM at all — organic and community sign-ups, which is exactly
       * where the date window was doing the guessing.
       */
      f("round_id", false, "round", "session", "session id", "registration list"),
      /**
       * THE NAME IS NOT AN IDENTITY. It is a HEADCOUNT KEY.
       *
       * Nothing is ever matched on it — two "Victor tan" in two rounds are two
       * people, and the importer still refuses to guess which. It is read for
       * one narrow job: a row carrying a name, a source and a date but no
       * address is a person we know ARRIVED and cannot NAME, and the two are
       * different facts. Counting them needs something stable to dedupe a
       * re-import against, and the name is the only thing such a row has.
       *
       * Same-name collisions inside one round therefore under-count by one,
       * never over-count, which is the direction this app errs in everywhere.
       */
      f("name", false, "full name", "contact name", "attendee name", "participant"),
      f("event_date", true, "created", "created at", "date created", "opt-in date", "date"),
      /**
       * WHERE THE PERSON CAME FROM — Paid Ads, AOAI, Organic.
       *
       * "channel" used to be an alias here and is deliberately gone: since 0022
       * channel means WHERE THE MONEY WAS SPENT (meta, google, tiktok), which is
       * a different question with different answers. A column headed "channel"
       * in a leads export is now left unmapped and listed back to the importer,
       * rather than silently read as the lead's source.
       */
      f("source", false, "lead source", "acquisition source"),
      /**
       * GoHighLevel writes three tracking tags and they mean different things.
       * Named here after what they HOLD, not after what the app once called
       * them, so a raw GHL export works with no hand-editing:
       *
       *   utm_term     the AUDIENCE   Cold_BusinessOwners     -> ad_set
       *   utm_content  the AD         Static_LetAISell...     -> ad
       *   utm_campaign the ROUND      DF_SG_Preview_..._0526_02
       *
       * utm_campaign is last in the ad_set alias list on purpose. Files built
       * before this change carry the audience in a column called utm_campaign;
       * they keep working, because utm_term wins wherever it is present.
       */
      f("ad_set", false, "utm_term", "ad set name", "adset", "audience", "utm_campaign"),
      f("ad", false, "utm_content", "ad name", "creative"),
      f("utm_campaign", false, "utm campaign", "campaign"),
    ],
  },
  attendance: {
    key: "attendance",
    label: "Attendance",
    kind: "Webinar platform · CSV",
    // The first instance of the generic per-person stage import rather than a
    // special case of it — see stageSpec below. Declaring the event type here
    // is what lets the pipeline branch on the spec instead of on the name.
    eventType: "attendance",
    fields: [
      f("round_id", true, "session", "session id", "webinar", "round"),
      f("email", true, "email address", "attendee email"),
      f("phone", false, "phone number", "mobile", "contact number"),
      // See the note on the leads spec: a headcount key, never a match key.
      f("name", false, "full name", "attendee name", "participant", "name (original name)"),
      /**
       * An identified attendee inherits their source from the lead that
       * acquired them, so this column is redundant for them. It is not
       * redundant for anyone else: a webinar roster carries people who never
       * opted in, and the export usually says which bucket they came from.
       * Without it their headcount would land under "Unattributed" and the
       * organic figure would still be missing.
       */
      f("source", false, "lead source", "acquisition source"),
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
      /**
       * WHERE THE BUYER CAME FROM — read only when they came from nowhere.
       *
       * A buyer who opted in has a lead, and the lead already carries the
       * source; this column is ignored for them, because the payments file is
       * the last place that should get to restate an acquisition. It is read
       * for the one case the lead cannot cover: someone who never opted in at
       * all. Without it their money lands under "Unattributed", which reads as
       * a failure to attribute rather than what it is — a sale no ad produced.
       *
       * It can never move a paid figure. attribution_bucket only reaches
       * 'Paid Ads' through a lead event (0020), so a value written here adds
       * revenue and contributes nothing to ROAS or CPA.
       */
      f("source", false, "lead source", "acquisition source"),
      f("amount", true, "total", "gross", "amount (sgd)"),
      f("refund_amount", false, "refunded", "refund", "amount refunded"),
      f("refund_date", false, "refunded at", "refund date"),
    ],
  },
  /**
   * The one source with no column mapping.
   *
   * A Clarity export is a metadata block and then a table, so there is no
   * header on line 1 to map and mapColumns is never called for it — the
   * pipeline branches to parseClarityScroll instead. `fields` is empty for that
   * reason rather than by omission, and the dropzone says what the file has to
   * contain in words instead of listing field names that don't exist.
   */
  scroll: {
    key: "scroll",
    label: "Landing page scroll",
    kind: "Microsoft Clarity · CSV",
    optional: true,
    template: false,
    expects: "Clarity's Scroll export, unedited — its date range picks the round",
    fields: [],
  },
};

const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Build field -> header mapping from a file's actual headers.
 * `remembered` is the previous committed mapping for this source; a header that
 * was mapped before and has vanished is reported as `broken`, not re-guessed.
 */
export function mapColumns(
  spec: SourceSpec,
  headers: string[],
  remembered?: Record<string, string> | null,
): { map: Record<string, string>; missing: string[]; broken: string[]; unused: string[] } {
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

/**
 * A source key naming a declared metric rather than one of the five built in.
 *
 * `stage:appointments` imports people who booked an appointment, for a client
 * whose journey says it measures them. The prefix keeps the two namespaces
 * apart so a declared metric can never collide with `ads` or `sales`, and so
 * import_batches can permit the whole family with one pattern.
 */
export const STAGE_PREFIX = "stage:";

export type ImportSourceKey = SourceKey | `${typeof STAGE_PREFIX}${string}`;

/** The metric a stage source imports, or null if this is a built-in source. */
export const stageMetricOf = (key: string): string | null =>
  key.startsWith(STAGE_PREFIX) ? key.slice(STAGE_PREFIX.length) || null : null;

/**
 * The import spec for a declared metric.
 *
 * Deliberately the attendance shape — a person, a round, and when — because
 * that IS the shape of "somebody reached this stage", and attendance was only
 * ever the first example of it. minutes_watched is the one attendance-specific
 * field and it is not offered here; a declared stage that needs its own column
 * is a bigger request than this, and inventing an unused field would suggest
 * otherwise.
 */
export function stageSpec(metric: string, label: string, eventType: string): SourceSpec {
  return {
    key: `${STAGE_PREFIX}${metric}` as SourceKey,
    label,
    kind: "CRM export · CSV",
    eventType,
    // Nothing forces a client to have one of these for every round, and a
    // permanent warning beside the four real ones teaches people to ignore all
    // five — the same reasoning scroll is optional for.
    optional: true,
    fields: [
      f("round_id", true, "session", "session id", "round", "campaign"),
      f("email", true, "email address", "contact email"),
      f("phone", false, "phone number", "mobile", "contact number"),
      f("event_date", false, "date", "booked at", "created", "timestamp"),
    ],
  };
}
