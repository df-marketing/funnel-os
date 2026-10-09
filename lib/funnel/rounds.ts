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
 * That is why an overlap within one market is guarded, and why changing an
 * existing round's dates goes through checkRoundEdit rather than create.
 *
 * WHAT THE OVERLAP RULE IS ACTUALLY ABOUT, corrected 9 Oct 2026.
 *
 * It used to refuse any two rounds of one market covering a day. That was a
 * rule about DATES standing in for a rule about AMBIGUITY, and the two came
 * apart as soon as a client arrived whose rounds are concurrent experiments
 * rather than consecutive weeks. The importer never had the stricter rule:
 * pipeline.ts falls through to the campaign name when more than one round
 * covers a day, and refuses the row when that settles nothing. So this file
 * was stricter than the thing it was written to protect.
 *
 * An overlap is now refused only when the campaigns do not separate the rounds.
 */

export type RoundInput = {
  code: string;
  startDate: string;
  endDate: string;
  sessionDate: string;
  sessionLabel: string;
  productId: string;
  market: string;
  /**
   * The exact Meta campaign names this round owns, or empty.
   *
   * Only ever consulted to tell two rounds of one market apart when they cover
   * the same day. A client whose rounds are consecutive weeks never needs it.
   */
  campaigns: string[];
};

export type ExistingRound = {
  round_id: string;
  code: string | null;
  start_date: string;
  end_date: string;
  market: string | null;
  product_id: string | null;
  campaigns?: string[] | null;
};

export type Verdict =
  | { kind: "ok"; round: RoundInput }
  | { kind: "identical"; round: RoundInput }
  | { kind: "invalid"; errors: Array<{ field: string; message: string }> }
  | { kind: "conflict"; code: "code_moved" | "overlaps" | "campaign_taken"; error: string };

/** The shape every existing round code uses: MMYY-NN. */
const CODE = /^\d{4}-\d{2}$/;

/**
 * The longest ads window that is not a mistyped year.
 *
 * This guard has one job, and it is worth being exact about which: a round
 * whose end date carries the wrong YEAR spans about 372 days and would swallow
 * every neighbouring round's spend, silently, because spend is filed by date.
 *
 * It was 92 days, which was Shely's quarter and nobody else's. FWD i-Care's
 * first round runs 2026-07-01 to 2026-10-06 — 98 days, because it is a
 * continuous experiment rather than a week — and was refused as a typo.
 *
 * Measured before moving it: 92 does not catch a mistyped MONTH either. The
 * same weekly round ending 2026-10-21 instead of 2026-09-21 spans 37 days and
 * passes today. So nothing is given up by raising this to half a year; the
 * only error it ever caught is the one a year typo makes, and that is 372.
 */
const MAX_WINDOW_DAYS = 186;

/**
 * How far a class may sit from the ads that paid for it before it reads as a
 * mistyped year. A different quantity from the window's length — this is a
 * DISTANCE from the window, not a span — so it keeps its own number. Three
 * months is already generous for a class, and a year typo puts it at 365.
 */
const CLASS_DRIFT_DAYS = 92;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day, not just four-two-two digits. 2026-02-30 is not a date. */
function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * WHETHER TWO ROUNDS COVERING ONE DAY CAN STILL BE TOLD APART.
 *
 * Meta writes the campaign name verbatim, so the comparison is trimmed and
 * case-folded and nothing else. NOT a substring or prefix match, which is the
 * one thing that cannot work here: FWD i-Care's Round 1 campaign name
 *
 *     FWD_iCareChi_META_MOFU_Sales_2026
 *
 * is a prefix of all six of the others —
 *
 *     FWD_iCareChi_META_MOFU_Sales_2026_SingleAttribution
 *     FWD_iCareChi_META_MOFU_Sales_2026_40To49   ... and so on
 *
 * — so substring matching files all 148 rows to Round 1, and "longest match
 * wins" (the tie-break roundFromCampaign uses to keep 0526-03 off 0526-031)
 * gets it exactly backwards, because Round 1's whole name is longer than the
 * suffix that distinguishes Round 2. Equality has no such failure mode.
 *
 * Empty on either side is NOT separable. A round that names no campaigns claims
 * every campaign it covers by date, which is right for a weekly round and is
 * why Shely needs none of this.
 */
const canonCampaign = (c: string) => c.trim().toLowerCase();

function sharedCampaigns(a: string[] | null | undefined, b: string[] | null | undefined): string[] {
  const left = new Set((a ?? []).map(canonCampaign).filter(Boolean));
  return [...new Set((b ?? []).map(canonCampaign).filter(Boolean))].filter((c) => left.has(c));
}

function separable(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const left = (a ?? []).map(canonCampaign).filter(Boolean);
  const right = (b ?? []).map(canonCampaign).filter(Boolean);
  if (!left.length || !right.length) return false;
  return sharedCampaigns(left, right).length === 0;
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
    /* THE CLASS IS NOT PART OF THE ADS WINDOW.
       
       It used to be required to fall inside it, and that was wrong twice over.
       Ads and classes run on their own schedules: ads for 0926-03 might run
       14-16 September for a class on the 17th, and nothing about that is odd.
       
       Worse, the rule caused the bug next to it. To record a class on the 17th
       an operator had to stretch the ads window to the 17th, and the NEXT
       round's ads starting that day were then refused as an overlap — by a
       date that was only there to satisfy this check. One wrong rule, two
       symptoms, and the second one looked unrelated.
       
       What is left is a typo guard, and only that: a class more than three
       months from the ads that paid for it is a mistyped year, not a schedule.
       Anything inside that is the client's business. */
    if (input.sessionDate) {
      const away = Math.min(
        Math.abs(Date.parse(input.sessionDate) - Date.parse(input.startDate)),
        Math.abs(Date.parse(input.sessionDate) - Date.parse(input.endDate)),
      ) / 86_400_000;
      if (away > CLASS_DRIFT_DAYS) {
        errors.push({
          field: "sessionDate",
          message: `the class is ${Math.round(away)} days from the ads window — check the year`,
        });
      }
    }
    /* A round that runs for months is almost always a typo in the year, and it
       would swallow every neighbouring round's spend. Warned about by refusing,
       because the failure it prevents is silent and this one is not. */
    const span = (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000 + 1;
    if (span > MAX_WINDOW_DAYS) {
      errors.push({ field: "endDate", message: `that is ${Math.round(span)} days — check the year` });
    }
  }

  if (errors.length) return { kind: "invalid", errors };

  const same = existing.find((r) => (r.code ?? r.round_id) === input.code);
  if (same) {
    if (same.start_date === input.startDate && same.end_date === input.endDate) {
      return { kind: "identical", round: input };
    }
    /* CREATE refuses to move a round; EDIT is where that happens, with the
       check that belongs to it. See checkRoundEdit.

       An earlier version of this message said moving a round "re-files every
       row already imported against it". That was asserted, not checked, and it
       is wrong: round_id is a stored foreign key on ads_performance and events
       (0001_schema.sql:70,91), so rows keep the round they were filed to. What
       moving the window actually does is leave some of them OUTSIDE it, and
       change which round a FUTURE import assigns a date to. */
    return {
      kind: "conflict",
      code: "code_moved",
      error: `${input.code} already exists as ${same.start_date} → ${same.end_date}. Use edit rather than create — it checks which already-imported rows would fall outside the new window.`,
    };
  }

  /* A campaign belongs to one round. Checked before overlap, because naming a
     campaign another round already owns is wrong whether or not the dates
     touch — and because the database enforces it with a trigger, so catching
     it here is the difference between a message and a 500. */
  const taken = existing.find((r) => sharedCampaigns(r.campaigns, input.campaigns).length > 0);
  if (taken) {
    const shared = sharedCampaigns(taken.campaigns, input.campaigns);
    return {
      kind: "conflict",
      code: "campaign_taken",
      error: `${taken.code ?? taken.round_id} already owns ${shared.length > 1 ? "these campaigns" : "this campaign"}: ${shared.join(", ")}. A campaign belongs to one round, or a day of its spend has two homes.`,
    };
  }

  /* OVERLAP, WITHIN THE MARKET, AND ONLY WHEN THE ROUNDS CANNOT BE TOLD APART.
     
     Two markets running their own schedules overlap constantly and that is
     fine — the ads importer resolves the market first precisely so it can.
     
     Within one market, what is actually wrong with an overlap is AMBIGUITY:
     "which round covers this day" having two answers. Dates are how that
     question is normally answered, so two rounds covering one day used to be
     refused outright. But the importer has never guessed — pipeline.ts falls
     through to the campaign name when more than one round covers a day, and
     refuses the row if that settles nothing either. So the overlap is only a
     problem when the campaigns do not separate the rounds.
     
     They do for FWD i-Care, whose three "rounds" are three concurrent
     experiments on one window — see
     supabase/migrations/20261010090000_two_rounds_may_share_a_week.sql. They do
     not for a client whose rounds are consecutive weeks and name no campaigns,
     which is every round that existed when this rule was written. That is why
     it read as a rule about rounds rather than about ambiguity. */
  const overlapping = existing.filter((r) =>
    (r.market ?? "").toUpperCase() === input.market &&
    input.startDate <= r.end_date &&
    input.endDate >= r.start_date,
  );
  const clash = overlapping.find((r) => !separable(r.campaigns, input.campaigns));
  if (clash) {
    /* ?? [] because input crosses a JSON boundary — the route builds this from
       a request body, and a caller that omits the field entirely should get
       the old behaviour rather than a TypeError. */
    const named = (clash.campaigns ?? []).length > 0 || (input.campaigns ?? []).length > 0;
    return {
      kind: "conflict",
      code: "overlaps",
      error: `These ADS DATES (${input.startDate} → ${input.endDate}) overlap ${clash.code ?? clash.round_id}, whose ads ran ${clash.start_date} → ${clash.end_date} in ${input.market}. Only the ads windows are compared — a class date is never part of this and may fall anywhere, including inside another round. ` +
        (named
          ? `${(clash.campaigns ?? []).length ? `This round names no campaigns, so it claims every one of those days` : `${clash.code ?? clash.round_id} names no campaigns, so it claims every campaign in its window`} — both rounds have to name theirs, or the day is still ambiguous.`
          : `Two rounds of one market covering the same day of SPEND makes that day ambiguous. If they ran at the same time on purpose — separate experiments rather than separate weeks — name the campaigns each one owns and both may keep the window.`),
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


/**
 * Whether a round's dates may be changed.
 *
 * WHAT MOVING A WINDOW ACTUALLY DOES, having checked rather than assumed:
 *
 *   it does NOT re-file imported rows. round_id is a stored foreign key on
 *   ads_performance and events, so every row keeps the round it was filed to.
 *
 *   it DOES change which round a future import assigns a day to — which is
 *   usually the whole point of correcting a date.
 *
 *   it CAN leave already-imported rows outside the round they belong to: an ad
 *   row dated 22 Sep sitting in a round that now ends on the 20th. Nothing
 *   breaks, and nothing says so either. That is the one worth surfacing, and
 *   the route counts it because it needs the database to.
 *
 *   it CAN move the round between months, because fo_round_anchor reads the
 *   dates. Only when the new window crosses the first of the named month.
 */
export type EditInput = {
  code: string;
  startDate: string;
  endDate: string;
  sessionDate: string;
  sessionLabel: string;
  /**
   * The campaigns this round owns. Editable because it is the fix for an
   * overlap: a round refused for covering another's week is allowed the moment
   * BOTH rounds name what they own, and one of those two is already created.
   */
  campaigns: string[];
};

export type EditVerdict =
  | { kind: "ok"; edit: EditInput; unchanged: boolean }
  | { kind: "invalid"; errors: Array<{ field: string; message: string }> }
  | { kind: "conflict"; code: "not_found" | "overlaps" | "campaign_taken"; error: string };

export function checkRoundEdit(input: EditInput, existing: ExistingRound[]): EditVerdict {
  const self = existing.find((r) => (r.code ?? r.round_id) === input.code);
  if (!self) {
    return { kind: "conflict", code: "not_found", error: `no round '${input.code}' for this client` };
  }

  const errors: Array<{ field: string; message: string }> = [];
  for (const f of ["startDate", "endDate", "sessionDate"] as const) {
    const v = input[f];
    if (f !== "sessionDate" && !v) { errors.push({ field: f, message: "required" }); continue; }
    if (v && !isRealDay(v)) errors.push({ field: f, message: `'${v}' is not a real date` });
  }
  if (!errors.length) {
    if (input.endDate < input.startDate) {
      errors.push({ field: "endDate", message: "the round ends before it starts" });
    }
    /* THE CLASS IS NOT PART OF THE ADS WINDOW.
       
       It used to be required to fall inside it, and that was wrong twice over.
       Ads and classes run on their own schedules: ads for 0926-03 might run
       14-16 September for a class on the 17th, and nothing about that is odd.
       
       Worse, the rule caused the bug next to it. To record a class on the 17th
       an operator had to stretch the ads window to the 17th, and the NEXT
       round's ads starting that day were then refused as an overlap — by a
       date that was only there to satisfy this check. One wrong rule, two
       symptoms, and the second one looked unrelated.
       
       What is left is a typo guard, and only that: a class more than three
       months from the ads that paid for it is a mistyped year, not a schedule.
       Anything inside that is the client's business. */
    if (input.sessionDate) {
      const away = Math.min(
        Math.abs(Date.parse(input.sessionDate) - Date.parse(input.startDate)),
        Math.abs(Date.parse(input.sessionDate) - Date.parse(input.endDate)),
      ) / 86_400_000;
      if (away > CLASS_DRIFT_DAYS) {
        errors.push({
          field: "sessionDate",
          message: `the class is ${Math.round(away)} days from the ads window — check the year`,
        });
      }
    }
    const span = (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000 + 1;
    if (span > MAX_WINDOW_DAYS) errors.push({ field: "endDate", message: `that is ${Math.round(span)} days — check the year` });
  }
  if (errors.length) return { kind: "invalid", errors };

  // Itself excluded throughout, or a round would always collide with where it
  // already is and always own its own campaigns.
  const others = existing.filter((r) => (r.code ?? r.round_id) !== input.code);

  const taken = others.find((r) => sharedCampaigns(r.campaigns, input.campaigns).length > 0);
  if (taken) {
    const shared = sharedCampaigns(taken.campaigns, input.campaigns);
    return {
      kind: "conflict",
      code: "campaign_taken",
      error: `${taken.code ?? taken.round_id} already owns ${shared.length > 1 ? "these campaigns" : "this campaign"}: ${shared.join(", ")}. A campaign belongs to one round.`,
    };
  }

  /* Same rule as create: an overlap only matters when the campaigns do not
     separate the two rounds. See checkRound. */
  const overlapping = others.filter((r) =>
    (r.market ?? "").toUpperCase() === (self.market ?? "").toUpperCase() &&
    input.startDate <= r.end_date &&
    input.endDate >= r.start_date,
  );
  const clash = overlapping.find((r) => !separable(r.campaigns, input.campaigns));
  if (clash) {
    return {
      kind: "conflict",
      code: "overlaps",
      error: `These ADS DATES (${input.startDate} → ${input.endDate}) overlap ${clash.code ?? clash.round_id}, whose ads ran ${clash.start_date} → ${clash.end_date} in ${self.market ?? "this market"}. Only the ads windows are compared — class dates are ignored here. Two rounds may share a window if BOTH name the campaigns they own.`,
    };
  }

  return {
    kind: "ok",
    edit: input,
    /* Dates only, deliberately. This is what the route uses to decide whether
       to count already-imported rows left outside the window, and that depends
       on the window alone — naming a campaign moves no row. */
    unchanged: self.start_date === input.startDate && self.end_date === input.endDate,
  };
}
