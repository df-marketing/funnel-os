/**
 * WHAT MAKES A ROUND VALID.
 *
 * Rounds were created by hand-written SQL until now, and the file that created
 * Shely's twelve had to fix three faults it found while doing it. Every one of
 * them is a rule here, because a screen that lets you make the same mistake
 * again is not an improvement on the SQL — it is the same trap with a nicer
 * surface.
 *
 * Pure: no database, no React, no server imports, so every rule below is tested
 * directly.
 */

export type RoundInput = {
  round_id: string;
  client_id: string;
  product_id: string | null;
  start_date: string;
  end_date: string;
  session_date: string | null;
  session_label: string | null;
};

/** An existing round to check against. The one being edited is excluded first. */
export type ExistingRound = {
  round_id: string;
  start_date: string;
  end_date: string;
  product_id?: string | null;
};

export type Problem = { field: string; message: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** MMYY-NN — the shape every round in this app is named for. */
export const ROUND_ID = /^(\d{2})(\d{2})-(\d{2})$/;

/**
 * The month a round's NAME declares. Also in cuts.ts, where the period list
 * needs it — this copy exists so validation has no reason to import a module
 * full of view routing.
 */
export const namedMonth = (roundId: string): string | null => {
  const m = ROUND_ID.exec(roundId);
  if (!m) return null;
  if (m[1] < "01" || m[1] > "12") return null;
  return `20${m[2]}-${m[1]}`;
};

const overlaps = (aStart: string, aEnd: string, bStart: string, bEnd: string) =>
  aStart <= bEnd && bStart <= aEnd;

export function validateRound(r: RoundInput, existing: ExistingRound[]): Problem[] {
  const p: Problem[] = [];

  // ── THE NAME ────────────────────────────────────────────────────────────
  if (!ROUND_ID.test(r.round_id)) {
    p.push({ field: "round_id",
      message: "A round is named MMYY-NN, like 0926-01 for the first round of September 2026." });
  } else if (!namedMonth(r.round_id)) {
    p.push({ field: "round_id", message: `${r.round_id.slice(0, 2)} is not a month.` });
  }

  // ── THE DATES ───────────────────────────────────────────────────────────
  if (!ISO.test(r.start_date)) p.push({ field: "start_date", message: "Needs a start date." });
  if (!ISO.test(r.end_date)) p.push({ field: "end_date", message: "Needs an end date." });
  if (ISO.test(r.start_date) && ISO.test(r.end_date) && r.start_date > r.end_date) {
    p.push({ field: "end_date", message: "The round ends before it starts." });
  }

  /*
   * The name has to agree with the dates, or the period list files the round
   * under a month it did not run in. Rounds routinely open in the month before
   * the one they are named for — 0826-01 runs 31 Jul to 6 Aug — so the test is
   * that the named month is touched, not that it matches the start.
   */
  const named = namedMonth(r.round_id);
  if (named && ISO.test(r.start_date) && ISO.test(r.end_date)) {
    const from = r.start_date.slice(0, 7);
    const to = r.end_date.slice(0, 7);
    if (named < from || named > to) {
      p.push({ field: "round_id",
        message: `${r.round_id} says ${named}, but the round runs ${from} to ${to}. ` +
                 "One of them is wrong." });
    }
  }

  /*
   * FAULT 1, from 1-rounds.sql: 0526-03 ended 27 May and its class was on the
   * 28th. The class day sat outside its own round, so a 28 May opt-in fell into
   * no window at all and was counted nowhere.
   */
  if (r.session_date) {
    if (!ISO.test(r.session_date)) {
      p.push({ field: "session_date", message: "Needs a date." });
    } else if (ISO.test(r.start_date) && ISO.test(r.end_date) &&
               (r.session_date < r.start_date || r.session_date > r.end_date)) {
      p.push({ field: "session_date",
        message: "The class is outside its own round, so anyone who signs up that day " +
                 "lands in no round at all. Extend the window to include it." });
    }
  }

  /*
   * FAULT 2: 0826-02 and 0826-03 were created with no product, and vanished the
   * moment anyone chose a product filter. A round belongs to something.
   */
  if (!r.product_id) {
    p.push({ field: "product_id",
      message: "Without a product this round disappears whenever anyone filters by one." });
  }

  /*
   * OVERLAP. Not cosmetic: a day of ad spend is assigned to the round whose
   * window contains it, which is what the Meta pull relies on. Two rounds
   * covering the same day makes that assignment arbitrary — whichever row the
   * database happens to return first wins.
   */
  if (ISO.test(r.start_date) && ISO.test(r.end_date) && r.start_date <= r.end_date) {
    const clash = existing.find((e) => overlaps(r.start_date, r.end_date, e.start_date, e.end_date));
    if (clash) {
      p.push({ field: "start_date",
        message: `These dates overlap ${clash.round_id} (${clash.start_date} to ${clash.end_date}). ` +
                 "A day of spend can only belong to one round." });
    }
  }

  return p;
}

/**
 * The label nobody should have to type twice.
 *
 * FAULT 3: both May rounds were labelled "Class A — Wed 8pm", which cannot tell
 * two sessions apart in a comparison. A date can.
 */
export const defaultSessionLabel = (sessionDate: string | null): string => {
  if (!sessionDate || !ISO.test(sessionDate)) return "";
  const d = new Date(`${sessionDate}T00:00:00Z`);
  return `Class ${d.toLocaleDateString("en-SG", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  })}`;
};

/** The next free number in a month, so the id does not have to be guessed. */
export const suggestRoundId = (month: string, existing: ExistingRound[]): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return "";
  const prefix = `${m[2]}${m[1].slice(2)}`;
  const used = existing
    .map((e) => ROUND_ID.exec(e.round_id))
    .filter((x): x is RegExpExecArray => !!x)
    .filter((x) => `${x[1]}${x[2]}` === prefix)
    .map((x) => Number(x[3]));
  const next = used.length ? Math.max(...used) + 1 : 1;
  return `${prefix}-${String(next).padStart(2, "0")}`;
};
