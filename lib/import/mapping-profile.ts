import type { ImportSourceKey, SourceSpec } from "./sources";

export type ProfileScope = Readonly<{
  clientId: string;
  source: ImportSourceKey;
  stageSlug: string | null;
}>;

export type ProfileDateRule = "auto" | "dmy" | "mdy";
export type ProfileRules = Readonly<{ dateOrder: ProfileDateRule }>;
export type MappingProfile = Readonly<ProfileScope & {
  name: string;
  headers: readonly string[];
  mapping: Readonly<Record<string, string>>;
  rules: ProfileRules;
}>;

export class MappingProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingProfileError";
  }
}

type ConfiguredStage = { slug: string; source: ImportSourceKey };

const BUILT_INS = new Set(["ads", "leads", "attendance", "sales"]);
const DATE_FIELDS = ["date", "date_end", "event_date", "refund_date"];
const DISALLOWED_HEADER = new Set(Object.getOwnPropertyNames(Object.prototype).map((s) => s.toLowerCase()));
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const STAGE_SOURCE = /^stage:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_HEADERS = 256;
const MAX_HEADER_LEN = 200;
const MAX_NAME_LEN = 80;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function ownKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const clean = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ");
const headerKey = (s: string) => clean(s).toLowerCase();

/** Use the same canonical key for the database uniqueness constraint. The
 * returned name is for display only and must not serve as a lookup key. */
export function mappingProfileNameKey(name: string): string {
  return headerKey(name);
}

/** Only call using the server-authorized client and stage/source bindings read
 * for that client, not a stage list supplied by the browser. */
export function resolveProfileScope(
  raw: unknown,
  authorizedClientId: string,
  configuredStages: readonly ConfiguredStage[],
): ProfileScope {
  const scope = record(raw);
  if (!scope || !ownKeys(scope, ["clientId", "source", "stageSlug"])) {
    throw new MappingProfileError("A valid profile scope is required.");
  }
  const { clientId, source, stageSlug } = scope;
  if (typeof clientId !== "string" || clientId !== authorizedClientId || !KEY.test(clientId) ||
      typeof source !== "string" || !(BUILT_INS.has(source) || STAGE_SOURCE.test(source)) ||
      !(stageSlug === null || (typeof stageSlug === "string" && KEY.test(stageSlug)))) {
    throw new MappingProfileError("This mapping profile does not belong to the selected import.");
  }
  const eligible = configuredStages.filter((s) => s.source === source);
  // A declared dataset must be attached to a currently configured stage.
  // A built-in dataset can remain unassigned only when there is no such stage.
  const validStage = stageSlug === null
    ? BUILT_INS.has(source) && eligible.length === 0
    : eligible.filter((s) => s.slug === stageSlug).length === 1;
  if (!validStage) {
    throw new MappingProfileError("Choose a configured journey stage for this dataset.");
  }
  return { clientId, source: source as ImportSourceKey, stageSlug };
}

function safeHeader(value: unknown): string | null {
  if (typeof value !== "string" || CONTROL.test(value) || value.length > MAX_HEADER_LEN) return null;
  const actual = value.trim();
  const key = headerKey(actual);
  if (!key || key.length > MAX_HEADER_LEN || DISALLOWED_HEADER.has(key)) return null;
  // A likely data row pasted in place of a header is not valid profile
  // metadata. This is a guardrail; the caller must pass headers, never rows.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key) || /^\+?[\d(). -]{7,}$/.test(key)) return null;
  return actual;
}

function indexHeaders(values: unknown): Map<string, string> {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_HEADERS) {
    throw new MappingProfileError("A profile needs between 1 and 256 non-empty column headers.");
  }
  const headers = new Map<string, string>();
  for (const value of values) {
    const actual = safeHeader(value);
    if (actual === null) throw new MappingProfileError("This file has a column header that cannot be saved in a profile.");
    const key = headerKey(actual);
    if (headers.has(key)) throw new MappingProfileError("This file has indistinguishable column headers. Rename one before using a profile.");
    headers.set(key, actual);
  }
  return headers;
}

const sameHeaders = (a: Map<string, string>, b: Map<string, string>) =>
  a.size === b.size && [...a.keys()].every((key) => b.has(key));

/** Explicit profile/manual mapping never silently falls back to another header.
 * Existing automatic/remembered mapping should keep its legacy behavior. */
export function validateMappingProfile(
  raw: unknown,
  scope: ProfileScope,
  spec: SourceSpec,
  currentHeaders?: readonly string[],
): MappingProfile {
  const item = record(raw);
  if (!item || !ownKeys(item, ["clientId", "source", "stageSlug", "name", "headers", "mapping", "rules"])) {
    throw new MappingProfileError("The mapping profile has an invalid format.");
  }
  if (item.clientId !== scope.clientId || item.source !== scope.source || item.stageSlug !== scope.stageSlug ||
      spec.key !== scope.source || !spec.fields.length || (scope.source as string) === "scroll") {
    throw new MappingProfileError("This mapping profile does not belong to the selected import.");
  }
  if (typeof item.name !== "string" || !item.name.trim() || item.name.length > MAX_NAME_LEN ||
      clean(item.name).length > MAX_NAME_LEN || CONTROL.test(item.name) ||
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(item.name))) {
    throw new MappingProfileError("Enter a profile name of 1–80 characters, without contact details.");
  }
  const saved = indexHeaders(item.headers);
  const current = currentHeaders === undefined ? saved : indexHeaders(currentHeaders);
  if (!sameHeaders(saved, current)) {
    throw new MappingProfileError("These headers differ from the saved file layout. Review the mapping before using it.");
  }

  const incoming = record(item.mapping);
  if (!incoming) throw new MappingProfileError("Select the matching upload column for each required GT field.");
  const allowed = new Map(spec.fields.map((field) => [field.field, field]));
  const used = new Set<string>();
  const entries: Array<[string, string]> = [];
  for (const [field, column] of Object.entries(incoming)) {
    if (!allowed.has(field) || DISALLOWED_HEADER.has(field.toLowerCase())) {
      throw new MappingProfileError("The profile contains a field that cannot be mapped for this dataset.");
    }
    if (typeof column !== "string" || column.length > MAX_HEADER_LEN || CONTROL.test(column)) {
      throw new MappingProfileError("Select a valid upload column from the file.");
    }
    const key = headerKey(column);
    if (!saved.has(key) || !current.has(key)) {
      throw new MappingProfileError("A mapped upload column is no longer present.");
    }
    if (used.has(key)) throw new MappingProfileError("Use each upload column for only one GT field.");
    entries.push([field, current.get(key)!]);
    used.add(key);
  }
  const mapped = new Set(entries.map(([field]) => field));
  const missing = spec.fields.filter((field) => field.required && !mapped.has(field.field));
  if (missing.length) {
    throw new MappingProfileError(`Required GT fields are not mapped: ${missing.map((field) => field.field).join(", ")}.`);
  }

  const rules = record(item.rules);
  if (!rules || !ownKeys(rules, ["dateOrder"]) ||
      !(rules.dateOrder === "auto" || rules.dateOrder === "dmy" || rules.dateOrder === "mdy")) {
    throw new MappingProfileError("Select automatic, day-first, or month-first dates.");
  }
  if (rules.dateOrder !== "auto" && !DATE_FIELDS.some((field) => mapped.has(field))) {
    throw new MappingProfileError("Map a date column before selecting a date format.");
  }
  return {
    clientId: scope.clientId, source: scope.source, stageSlug: scope.stageSlug,
    name: clean(item.name), headers: [...current.values()], mapping: Object.fromEntries(entries),
    rules: { dateOrder: rules.dateOrder },
  };
}

/** Matching is suggestion-only. File columns may be reordered or differ in
 * capitalization/spacing, but there must be no missing, extra or duplicate
 * normalized headers. Deliberately no fuzzy guesses or auto-application. */
export function matchMappingProfile(
  raw: unknown,
  scope: ProfileScope,
  spec: SourceSpec,
  currentHeaders: readonly string[],
): MappingProfile | null {
  try {
    return validateMappingProfile(raw, scope, spec, currentHeaders);
  } catch (error) {
    if (error instanceof MappingProfileError) return null;
    throw error;
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(.*)$/u;
const LOCAL_DATE = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})(.*)$/u;
const CLOCK = /^(?:[ T](\d{1,2}):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:\s*([AP]M))?(Z|[+-]\d\d:?\d\d)?)?$/i;

function validCalendar(year: number, month: number, day: number): boolean {
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

/** Explicit slash date rule: verify what the operator chose, then rewrite to
 * ISO before calling legacy timestamp/coverage logic. ISO inputs (including
 * converted workbook dates) remain ISO. Empty values remain empty so normal
 * importer validation decides whether a cell is required. Errors never
 * contain cell contents. `auto` is the untouched legacy path. */
export function normalizeProfileDate(value: string, rule: ProfileDateRule): string {
  if (rule === "auto" || !value.trim()) return value;
  const text = value.trim();
  const iso = ISO_DATE.exec(text);
  const local = LOCAL_DATE.exec(text);
  if (!iso && !local) throw new MappingProfileError("A date is not ISO or in the chosen date format.");
  const y = Number(iso ? iso[1] : local![4]);
  const m = Number(iso ? iso[2] : local![rule === "dmy" ? 3 : 1]);
  const d = Number(iso ? iso[3] : local![rule === "dmy" ? 1 : 3]);
  const suffix = (iso ? iso[4] : local![5]).trim();
  if (!validCalendar(y, m, d)) throw new MappingProfileError("A date is invalid or contradicts the chosen date format.");
  const clock = CLOCK.exec(suffix ? (suffix.startsWith("T") ? suffix : ` ${suffix}`) : "");
  if (!clock) throw new MappingProfileError("The file contains a time in an unsupported format.");
  const [hour, minute, second] = clock.slice(1, 4).map((part) => Number(part ?? 0));
  const half = clock[4];
  const zone = clock[5];
  if ((half ? hour < 1 || hour > 12 : hour > 23) || minute > 59 || second > 59 ||
      (zone && (!iso || half || Number.isNaN(Date.parse(text))))) {
    throw new MappingProfileError("The file contains an invalid or unsupported time.");
  }
  if (iso) return text;
  const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return suffix ? `${date} ${suffix.replace(/^T/, "")}` : date;
}
