/**
 * Whether a round may be created. Pure, so it can be pinned by a test.
 *
 * The route reads rows and writes one; this decides. Same split as every other
 * decision in this codebase, and for the same reason: a guard that lives inside
 * a request handler is a guard nothing can assert against.
 *
 * WHY A ROUND IS WORTH GUARDING THIS HARD.
 *
 * A day of ad spend is filed to a round BY DATE — lib/import/pipeline.ts:733-738
 * resolves the market from the campaign prefix, then asks which round covers the
 * day. So a round's window is not a label on a report. It is the thing that
 * decides where money lands, and it decides silently: a wrong date does not
 * fail an import, it files the spend under the neighbouring round and the
 * account total stays right while every per-round figure moves.
 *
 * That is why two rounds may not overlap within a market, and why changing an
 * existing round's dates is refused rather than offered.
 */

export type RoundInput = {
  code: string;
  startDate: string;
  endDate: string;
  sessionDate: string;
  sessionLabel: string;
  productId: string;
  market: string;
};

export type ExistingRound = {
  round_id: string;
  code: string | null;
  start_date: string;
  end_date: string;
  market: string | null;
  product_id: string | null;
};

export type Verdict =
  | { kind: "ok"; round: RoundInput }
  | { kind: "identical"; round: RoundInput }
  | { kind: "invalid"; errors: Array<{ field: string; message: string }> }
  | { kind: "conflict"; code: "code_moved" | "overlaps"; error: string };

/** The shape every existing round code uses: MMYY-NN. */
const CODE = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day, not just four-two-two digits. 2026-02-30 is not a date. */
function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function checkRound(input: RoundInput, existing: ExistingRound[]): Verdict {
  const errors: Array<{ field: string; message: string }> = [];
  const need = (field: keyof RoundInput, message: string) => {
    if (!input[field]) errors.push({ field, message });
  };

  need("code", "a round code is required, like 0926-05");
  need("startDate", "a start date is required");
  need("endDate", "an end date is required");
  need("productId", "choose which product this round ran");
  need("market", "choose the market");

  if (input.code && !CODE.test(input.code)) {
    errors.push({ field: "code", message: `'${input.code}' is not a round code — it looks like 0926-05 (month, year, then the round's number that month)` });
  }
  for (const f of ["startDate", "endDate", "sessionDate"] as const) {
    const v = input[f];
    if (v && !isRealDay(v)) errors.push({ field: f, message: `'${v}' is not a real date` });
  }

  // Only worth checking the relationships once the dates themselves are sound.
  if (!errors.length) {
    if (input.endDate < input.startDate) {
      errors.push({ field: "endDate", message: "the round ends before it starts" });
    }
    if (input.sessionDate) {
      if (input.sessionDate < input.startDate || input.sessionDate > input.endDate) {
        errors.push({
          field: "sessionDate",
          message: `the class is on ${input.sessionDate}, outside the round (${input.startDate} → ${input.endDate})`,
        });
      }
    }
    /* A round that runs for months is almost always a typo in the year, and it
       would swallow every neighbouring round's spend. Warned about by refusing,
       because the failure it prevents is silent and this one is not. */
    const span = (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000 + 1;
    if (span > 92) {
      errors.push({ field: "endDate", message: `that is ${Math.round(span)} days — check the year` });
    }
  }

  if (errors.length) return { kind: "invalid", errors };

  const same = existing.find((r) => (r.code ?? r.round_id) === input.code);
  if (same) {
    if (same.start_date === input.startDate && same.end_date === input.endDate) {
      return { kind: "identical", round: input };
    }
    /* Moving a round re-files everything already imported against it, silently
       and in bulk. Not something a form should do on a Tuesday. */
    return {
      kind: "conflict",
      code: "code_moved",
      error: `${input.code} already exists as ${same.start_date} → ${same.end_date}. Changing a round's dates re-files every row already imported against it, so it is not something this screen will do — move it in SQL, deliberately, if that is really the intent.`,
    };
  }

  /* Overlap, within the market only. Two markets running their own schedules
     overlap constantly and that is fine — the ads importer resolves the market
     first precisely so it can. Two rounds of the SAME market covering one day
     is the case where "which round covers this?" has two answers and array
     order picks the winner. */
  const clash = existing.find((r) =>
    (r.market ?? "").toUpperCase() === input.market &&
    input.startDate <= r.end_date &&
    input.endDate >= r.start_date,
  );
  if (clash) {
    return {
      kind: "conflict",
      code: "overlaps",
      error: `${input.startDate} → ${input.endDate} overlaps ${clash.code ?? clash.round_id} (${clash.start_date} → ${clash.end_date}) in ${input.market}. Two rounds of one market covering the same day makes a day of spend ambiguous, and the importer would file it by whichever came back first.`,
    };
  }

  return { kind: "ok", round: input };
}

/**
 * The next code after the newest round in a month, for prefilling the form.
 *
 * Convenience only — a wrong suggestion is corrected by typing over it, and the
 * guards above are what actually decide. Returns null rather than guessing when
 * there is nothing to count from.
 */
export function suggestNextCode(existing: ExistingRound[], afterDate: string): string | null {
  if (!isRealDay(afterDate)) return null;
  const [y, m] = afterDate.split("-");
  const prefix = `${m}${y.slice(2)}`;          // 2026-09 → "0926"
  const used = existing
    .map((r) => r.code ?? r.round_id)
    .filter((c) => c.startsWith(`${prefix}-`))
    .map((c) => Number(c.slice(prefix.length + 1)))
    .filter((n) => Number.isInteger(n));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}-${String(next).padStart(2, "0")}`;
}
