import type { MetricKey } from "@/lib/funnel/spine";

export const SOURCE_TYPES = ["meta", "google", "crm", "csv"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * The semantic stage metrics supported by v_journey_strip, mapped to the
 * metric object key returned by fo_cut. This is deliberately the same six-case
 * set as 0031's SQL CASE expression and each target is checked by TypeScript
 * against MetricKey. Additions must update both places in the same migration.
 */
export const JOURNEY_METRIC_KEYS = {
  impressions: "impr",
  clicks: "clicks",
  leads: "leads",
  attendance: "att",
  preview_purchases: "prevBuy",
  middle_purchases: "midBuy",
} as const satisfies Record<string, MetricKey>;

export type JourneyMetric = keyof typeof JOURNEY_METRIC_KEYS;

export type SchemaStage = {
  order: number;
  slug: string;
  name: string;
  metric: JourneyMetric;
  sourceType: SourceType;
  sourceRef: string;
  compareDimension: string | null;
  rateLabel: string | null;
  unitPrice: number | null;
};

export type FunnelSchema = {
  clientId: string;
  clientName: string;
  /** Switcher subtitle. Omitted keeps whatever is stored, like unit_price. */
  clientNote: string | null;
  /**
   * The caller asserting it is opening a client that does not exist yet.
   * Without it an unknown clientId is a typo, not an onboarding.
   */
  createClient: boolean;
  source: "acqos";
  schemaVersion: number;
  generatedAt: string;
  stages: SchemaStage[];
};

export type SchemaProblem = {
  stage: number | null;
  field: string;
  message: string;
};

const CLIENT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIMENSION = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const string = (value: unknown) => typeof value === "string" ? value.trim() : "";

function validDateTime(value: string) {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

/** Validate everything before a schema replacement can touch the database. */
export function validateFunnelSchema(input: unknown):
  | { ok: true; value: FunnelSchema }
  | { ok: false; errors: SchemaProblem[] } {
  const errors: SchemaProblem[] = [];
  if (!isObject(input)) {
    return { ok: false, errors: [{ stage: null, field: "body", message: "expected a JSON object" }] };
  }

  const clientId = string(input.clientId);
  const clientName = string(input.clientName);
  const source = string(input.source);
  const generatedAt = string(input.generatedAt);
  const schemaVersion = input.schemaVersion;
  const rows = input.stages;
  const clientNote = input.clientNote;
  const createClient = input.createClient;

  if (!CLIENT_ID.test(clientId)) {
    errors.push({ stage: null, field: "clientId", message: "must be lowercase letters, numbers, underscores or hyphens" });
  }
  if (!clientName) errors.push({ stage: null, field: "clientName", message: "is required" });
  if (source !== "acqos") errors.push({ stage: null, field: "source", message: "must be 'acqos'" });
  if (!Number.isInteger(schemaVersion) || schemaVersion !== 1) {
    errors.push({ stage: null, field: "schemaVersion", message: "must be integer 1" });
  }
  if (!validDateTime(generatedAt)) errors.push({ stage: null, field: "generatedAt", message: "must be an ISO date-time" });
  if (clientNote !== undefined && clientNote !== null && !string(clientNote)) {
    errors.push({ stage: null, field: "clientNote", message: "must be omitted, null, or non-empty text" });
  }
  if (createClient !== undefined && typeof createClient !== "boolean") {
    errors.push({ stage: null, field: "createClient", message: "must be omitted or a boolean" });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push({ stage: null, field: "stages", message: "must contain at least one stage" });
  }

  const stages: SchemaStage[] = [];
  if (Array.isArray(rows)) {
    rows.forEach((row, index) => {
      const stage = index + 1;
      if (!isObject(row)) {
        errors.push({ stage, field: "stage", message: "must be an object" });
        return;
      }
      const order = row.order;
      const slug = string(row.slug);
      const name = string(row.name);
      const metric = string(row.metric);
      const sourceType = string(row.sourceType);
      const sourceRef = string(row.sourceRef);
      const compareDimension = row.compareDimension;
      const rateLabel = row.rateLabel;
      const unitPrice = row.unitPrice;

      if (!Number.isInteger(order) || Number(order) < 1) errors.push({ stage, field: "order", message: "must be a positive integer" });
      if (!SLUG.test(slug)) errors.push({ stage, field: "slug", message: "must be lowercase and hyphenated" });
      if (!name) errors.push({ stage, field: "name", message: "is required" });
      if (!(metric in JOURNEY_METRIC_KEYS)) {
        errors.push({ stage, field: "metric", message: `unknown metric '${metric}' — not in the journey-strip case expression` });
      }
      if (!SOURCE_TYPES.includes(sourceType as SourceType)) {
        errors.push({ stage, field: "sourceType", message: "must be meta, google, crm or csv" });
      }
      if (!sourceRef) errors.push({ stage, field: "sourceRef", message: "is required" });
      if (compareDimension !== null && (!string(compareDimension) || !DIMENSION.test(string(compareDimension)))) {
        errors.push({ stage, field: "compareDimension", message: "must be null or table.column" });
      }
      if (rateLabel !== null && !string(rateLabel)) errors.push({ stage, field: "rateLabel", message: "must be null or non-empty text" });
      if (unitPrice !== null && (typeof unitPrice !== "number" || !Number.isFinite(unitPrice) || unitPrice < 0)) {
        errors.push({ stage, field: "unitPrice", message: "must be null or a non-negative number" });
      }

      if (
        Number.isInteger(order) && Number(order) >= 1 && SLUG.test(slug) && name &&
        metric in JOURNEY_METRIC_KEYS && SOURCE_TYPES.includes(sourceType as SourceType) && sourceRef &&
        (compareDimension === null || DIMENSION.test(string(compareDimension))) &&
        (rateLabel === null || string(rateLabel)) &&
        (unitPrice === null || (typeof unitPrice === "number" && Number.isFinite(unitPrice) && unitPrice >= 0))
      ) {
        stages.push({
          order: Number(order), slug, name, metric: metric as JourneyMetric,
          sourceType: sourceType as SourceType, sourceRef,
          compareDimension: compareDimension === null ? null : string(compareDimension),
          rateLabel: rateLabel === null ? null : string(rateLabel), unitPrice: unitPrice as number | null,
        });
      }
    });
  }

  // Check the declared orders separately from the remaining stage fields. A
  // bad metric must not conceal a missing order in the same payload.
  const declaredOrders = Array.isArray(rows)
    ? rows.flatMap((row) => isObject(row) && Number.isInteger(row.order) && Number(row.order) >= 1
      ? [Number(row.order)] : [])
    : [];
  const duplicates = new Set(declaredOrders.filter((order, i) => declaredOrders.indexOf(order) !== i));
  for (const order of duplicates) errors.push({ stage: order, field: "order", message: `duplicate order ${order}` });

  // Slugs must be unique too, and not only because Ground Up keys on them: the
  // replace preserves unit_price by slug, so two stages sharing one would both
  // inherit the same price. The primary key is (client_id, stage_order), which
  // means the database accepts the collision without complaint.
  const declaredSlugs = Array.isArray(rows)
    ? rows.flatMap((row) => (isObject(row) && string(row.slug) ? [string(row.slug)] : []))
    : [];
  const repeatedSlugs = new Set(declaredSlugs.filter((slug, i) => declaredSlugs.indexOf(slug) !== i));
  for (const slug of repeatedSlugs) {
    errors.push({ stage: null, field: "slug", message: `duplicate slug '${slug}' — each stage needs its own` });
  }
  if (Array.isArray(rows)) {
    for (let order = 1; order <= rows.length; order++) {
      if (!declaredOrders.includes(order)) errors.push({ stage: null, field: "order", message: `missing order ${order}; orders must be contiguous from 1` });
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      clientId, clientName,
      clientNote: clientNote === undefined || clientNote === null ? null : string(clientNote),
      createClient: createClient === true,
      source: "acqos", schemaVersion: 1, generatedAt,
      stages: stages.sort((a, b) => a.order - b.order),
    },
  };
}

export function isIsoDay(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
