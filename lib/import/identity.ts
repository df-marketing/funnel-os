/**
 * Identity normalisation and matching.
 *
 * The brief is explicit and it is a hard rule: email primary, phone secondary,
 * both normalised. NO FUZZY NAME MATCHING, EVER. A row matches or it doesn't —
 * it is never guessed into a round.
 *
 * The pipeline has three outcomes, not two:
 *   EXACT         email or phone matches a known contact          → counted
 *   AUTO-RESOLVED plus-addressed email, or phone formatting only   → counted, no review
 *   PARKED        anything else                                    → not counted, revenue held
 */

export type MatchOutcome =
  | { kind: "exact"; contactId: string }
  | { kind: "auto"; contactId: string; method: string }
  | { kind: "new" }
  | { kind: "park"; reason: ParkReason; bestGuess: string | null; guessMethod: string | null; confidence: "low" | "none" };

/**
 * Why a row was parked — and these are four different problems with four
 * different fixes, so they are four different values.
 *
 * `name_only` means we know the row and not the person. It must NOT be reused
 * for a row we couldn't use at all: a lead with an email but no opt-in date was
 * being filed under "no contact detail" with its address right there in the row.
 */
export type ParkReason =
  | "same_person_two_addresses"
  | "phone_format"
  | "name_only"
  | "bought_without_lead"
  | "incomplete_row"      // missing a field the app needs — fix the file
  | "no_matching_round"   // the row is fine; no round exists to attach it to
  | "unknown_person";     // has contact detail, but nobody here matches it

export const normEmail = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
};

/** meilin.w+2@gmail.com → meilin.w@gmail.com. The alias IS the same mailbox. */
export const stripPlus = (email: string): string => {
  const [local, domain] = email.split("@");
  return local.includes("+") ? `${local.split("+")[0]}@${domain}` : email;
};

/**
 * Phone → E.164. Singapore numbers are 8 digits starting 6/8/9; anything already
 * carrying a country code is left alone. A number we can't confidently place is
 * returned null rather than mangled into a wrong +65.
 */
export const normPhone = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const plus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  if (plus) return `+${digits}`;
  if (digits.length === 8 && /^[689]/.test(digits)) return `+65${digits}`;
  if (digits.length === 10 && digits.startsWith("65")) return `+${digits}`;
  if (digits.length >= 10) return `+${digits}`;
  return null;
};

export type KnownContact = { contact_id: string; email: string | null; phone: string | null };

export type Index = {
  byEmail: Map<string, string>;
  byPlusStripped: Map<string, string>;
  byPhone: Map<string, string>;
  byDigits: Map<string, string>;
};

export function buildIndex(contacts: KnownContact[]): Index {
  const byEmail = new Map<string, string>();
  const byPlusStripped = new Map<string, string>();
  const byPhone = new Map<string, string>();
  const byDigits = new Map<string, string>();

  for (const c of contacts) {
    const e = normEmail(c.email);
    if (e) {
      byEmail.set(e, c.contact_id);
      byPlusStripped.set(stripPlus(e), c.contact_id);
    }
    const p = normPhone(c.phone);
    if (p) {
      byPhone.set(p, c.contact_id);
      byDigits.set(p.replace(/\D/g, "").slice(-8), c.contact_id);
    }
  }
  return { byEmail, byPlusStripped, byPhone, byDigits };
}

/**
 * @param createIfNew  true for leads (a lead IS the creation of a contact);
 *                     false for attendance and sales, where a row with no known
 *                     person gets parked instead of inventing one.
 */
export function matchRow(
  index: Index,
  rawEmail: string | null,
  rawPhone: string | null,
  createIfNew: boolean,
): MatchOutcome {
  const email = normEmail(rawEmail);
  const phone = normPhone(rawPhone);

  if (email) {
    const hit = index.byEmail.get(email);
    if (hit) return { kind: "exact", contactId: hit };
  }
  if (phone) {
    const hit = index.byPhone.get(phone);
    if (hit) return { kind: "exact", contactId: hit };
  }

  // AUTO — same mailbox, different spelling of it
  if (email) {
    const stripped = stripPlus(email);
    if (stripped !== email) {
      const hit = index.byEmail.get(stripped) ?? index.byPlusStripped.get(stripped);
      if (hit) return { kind: "auto", contactId: hit, method: "plus-addressed alias" };
    }
  }
  // AUTO — same digits, different formatting
  if (phone) {
    const hit = index.byDigits.get(phone.replace(/\D/g, "").slice(-8));
    if (hit) return { kind: "auto", contactId: hit, method: "phone normalisation" };
  }

  if (!email && !phone) {
    return { kind: "park", reason: "name_only", bestGuess: null, guessMethod: null, confidence: "none" };
  }

  if (createIfNew) return { kind: "new" };

  // Known person, unknown address: offer the strongest same-signal candidate but
  // never apply it. A second address for the same human is a human's call.
  if (phone) {
    const sameDigits = index.byDigits.get(phone.replace(/\D/g, "").slice(-8));
    if (sameDigits) {
      return { kind: "park", reason: "phone_format", bestGuess: phone, guessMethod: "same digits", confidence: "low" };
    }
  }
  // We have contact detail and nobody here matches it. What that MEANS depends
  // on the file — a sale from a stranger is revenue with no spend behind it,
  // an attendance from a stranger is someone who showed up without ever opting
  // in. matchRow doesn't know which file it's reading, so it doesn't guess: the
  // pipeline names it, because the pipeline knows the source.
  return {
    kind: "park",
    reason: "unknown_person",
    bestGuess: null,
    guessMethod: null,
    confidence: "none",
  };
}
