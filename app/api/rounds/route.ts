import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { requireStaff } from "@/lib/auth/access";
import { createAdminClient, MISSING_KEY_MESSAGE } from "@/lib/supabase/admin";
import { FUNNEL_TAG } from "@/lib/supabase/read";
import { checkRound, checkRoundEdit, suggestNextCode, type ExistingRound } from "@/lib/funnel/rounds";

export const runtime = "nodejs";

/* Offered to a client that has no rounds to infer from. Not a validation list
   — checkRound takes whatever market a round declares — just what the dropdown
   suggests before there is any history to read. */
const ALL_MARKETS = ["SG", "MY"];

/**
 * POST /api/rounds — create one round.
 *
 * STEP 0 FINALLY HAS A SCREEN.
 *
 * Every other step of the import had one. This was the gap the Import tab
 * admitted to in its own copy: an import is refused outright if the round it
 * names does not exist, and the only way to make one was a SQL insert. So the
 * straight line ran through the Supabase editor once per round, for a row with
 * five fields in it.
 *
 * ── THE GUARDS ARE THE POINT, NOT THE FORM ────────────────────────────────
 *
 * A round is not an innocuous row. Spend is filed against it BY DATE
 * (lib/import/pipeline.ts:733-738), so its window silently decides which round
 * a day of money belongs to. Get the dates wrong and nothing fails — the money
 * lands under the neighbour, and the first sign is a ROAS that looks odd a
 * month later.
 *
 * So this refuses exactly what the hand-written SQL refused, and for the same
 * reasons. The decisions live in lib/funnel/rounds.ts, pure and tested, because
 * a guard that only exists inside a route handler cannot be pinned by a test.
 *
 * ── WHOSE ROUND IS IT ─────────────────────────────────────────────────────
 *
 * AcqOS owns the cycle; this is its shadow. Nothing here pushes back to them,
 * so a round created in this screen is one AcqOS does not know about. That is
 * already true of every round created by SQL, and this does not make it worse —
 * but the day AcqOS gains a round-push endpoint, there are two writers to the
 * same table and that needs deciding rather than discovering.
 */

/**
 * GET /api/rounds?clientId=… — what the form needs to draw itself.
 *
 * The existing rounds (so it can suggest the next code and show what it would
 * sit beside) and the client's products. Fetched by the form rather than
 * threaded through ImportPane's props, because this is the only screen that
 * wants them and a prop added for one component is a prop every caller has to
 * carry.
 */
export async function GET(request: Request) {
  const denied = await requireStaff();
  if (denied) return denied;

  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ ok: false, error: "clientId is required" }, { status: 400 });

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  const [roundsResult, productsResult] = await Promise.all([
    db.from("rounds")
      .select("round_id, code, start_date, end_date, market, product_id")
      .eq("client_id", clientId).order("start_date", { ascending: false }),
    db.from("v_products").select("product_id, product_name").eq("client_id", clientId).order("product_name"),
  ]);
  if (roundsResult.error) return NextResponse.json({ ok: false, error: roundsResult.error.message }, { status: 500 });

  const rounds = (roundsResult.data ?? []) as ExistingRound[];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });

  return NextResponse.json({
    ok: true,
    rounds: rounds.slice(0, 8),
    products: productsResult.data ?? [],
    /* The markets this client has used, or every market the business runs in
       when it has no rounds yet. A new client would otherwise be offered only
       the markets of rounds it does not have — which for FWD i-Care, whose
       first round is its first anything, meant an empty list. */
    markets: (() => {
      const used = [...new Set(rounds.map((r) => r.market).filter(Boolean))] as string[];
      return used.length ? used : ALL_MARKETS;
    })(),
    // A suggestion, not a decision — checkRound is what actually rules.
    suggested: suggestNextCode(rounds, today),
  });
}

export async function POST(request: Request) {
  const denied = await requireStaff();
  if (denied) return denied;

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const clientId = str("clientId");
  if (!clientId) return NextResponse.json({ ok: false, error: "clientId is required" }, { status: 400 });

  /* Every round this client already has, for the overlap and duplicate checks.
     Read in full rather than queried per-rule: there are tens of them, and one
     round of its own is the thing a new round is most likely to collide with. */
  const { data: existing, error: readError } = await db
    .from("rounds")
    .select("round_id, code, start_date, end_date, market, product_id")
    .eq("client_id", clientId);
  if (readError) return NextResponse.json({ ok: false, error: readError.message }, { status: 500 });

  const verdict = checkRound(
    {
      code: str("code"),
      startDate: str("startDate"),
      endDate: str("endDate"),
      sessionDate: str("sessionDate"),
      sessionLabel: str("sessionLabel"),
      productId: str("productId"),
      market: str("market").toUpperCase(),
    },
    (existing ?? []) as ExistingRound[],
  );

  if (verdict.kind === "invalid") {
    // Every problem at once. Fixing one field, resubmitting and being told about
    // the next is four round trips for one form.
    return NextResponse.json({ ok: false, errors: verdict.errors }, { status: 400 });
  }

  if (verdict.kind === "identical") {
    // Already there, same dates. A repeat submission, not a conflict.
    return NextResponse.json({
      ok: true, created: false, code: verdict.round.code,
      note: "that round already exists with these dates — nothing was changed",
    });
  }

  if (verdict.kind === "conflict") {
    return NextResponse.json({ ok: false, code: verdict.code, error: verdict.error }, { status: 409 });
  }

  const r = verdict.round;
  const { error: writeError } = await db.from("rounds").insert({
    round_id: r.code,
    client_id: clientId,
    code: r.code,
    start_date: r.startDate,
    end_date: r.endDate,
    session_date: r.sessionDate,
    session_label: r.sessionLabel,
    product_id: r.productId,
    market: r.market,
    /* NULL on purpose, matching every recent round. A round is in a country if
       it RAN there, which v_round_markets answers from the data; a column
       somebody typed is a declaration, and the two disagree the moment a round
       runs in two markets. */
    country: null,
  });
  if (writeError) return NextResponse.json({ ok: false, error: writeError.message }, { status: 500 });

  revalidatePath("/");
  revalidateTag(FUNNEL_TAG);

  return NextResponse.json({ ok: true, created: true, code: r.code }, { status: 201 });
}


/**
 * PATCH /api/rounds — change one round's dates.
 *
 * Henry's rounds had the wrong dates and the create form told him to go and do
 * it in SQL, on the strength of a claim I had not checked: that moving a round
 * "re-files every row already imported against it". It does not. round_id is a
 * stored foreign key on ads_performance and events, so rows keep the round they
 * were filed to.
 *
 * WHAT IS ACTUALLY WORTH GUARDING is the thing that claim was standing in front
 * of: moving a window can leave already-imported rows OUTSIDE it. An ad dated
 * 22 September in a round that now ends on the 20th is not an error, is not
 * re-filed, and nothing on any screen says so. So this counts them, names them
 * by source, and refuses until somebody says they know.
 *
 * `acknowledgeStrays: true` is the override, and it is deliberately a different
 * word from `force` — the same split as the freeze guard. One says "I know the
 * dates are unusual"; this says "I know rows will be left outside".
 */
export async function PATCH(request: Request) {
  const denied = await requireStaff();
  if (denied) return denied;

  const db = createAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: MISSING_KEY_MESSAGE }, { status: 503 });

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 }); }

  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const clientId = str("clientId");
  if (!clientId) return NextResponse.json({ ok: false, error: "clientId is required" }, { status: 400 });

  const { data: existing, error: readError } = await db
    .from("rounds")
    .select("round_id, code, start_date, end_date, market, product_id")
    .eq("client_id", clientId);
  if (readError) return NextResponse.json({ ok: false, error: readError.message }, { status: 500 });

  const verdict = checkRoundEdit(
    {
      code: str("code"), startDate: str("startDate"), endDate: str("endDate"),
      sessionDate: str("sessionDate"), sessionLabel: str("sessionLabel"),
    },
    (existing ?? []) as ExistingRound[],
  );
  if (verdict.kind === "invalid") return NextResponse.json({ ok: false, errors: verdict.errors }, { status: 400 });
  if (verdict.kind === "conflict") return NextResponse.json({ ok: false, code: verdict.code, error: verdict.error }, { status: verdict.code === "not_found" ? 404 : 409 });

  const e = verdict.edit;
  const roundId = ((existing ?? []) as ExistingRound[]).find((r) => (r.code ?? r.round_id) === e.code)!.round_id;

  /* AD ROWS ONLY, and only when the window is actually moving.
     
     This counted events too, and that was wrong for the same reason the class
     rule was wrong: it treated the ads window as if it governed everything.
     
     An ad row's round is decided BY DATE, so one sitting outside the window
     means the window is wrong. An EVENT's round is not: it comes from the
     file's own round_id, or from attribution. A person opting in after the ads
     stop is ordinary — measured on shely, 11 of her 15 rounds have events
     dated outside their ads window, 161 events in all. Warning about that
     meant warning on nearly every round, and a warning that fires every time
     is one nobody reads.
     
     Skipped entirely when the dates are unchanged. Re-saving a round without
     touching its window moves nothing, so there is nothing to be told. */
  const strays = { ads: 0, events: 0, adDates: [] as string[] };
  let total = 0;

  if (!verdict.unchanged) {
    const adsOut = await db.from("ads_performance").select("date", { count: "exact" })
      .eq("round_id", roundId).or(`date.lt.${e.startDate},date.gt.${e.endDate}`);
    strays.ads = adsOut.count ?? 0;
    strays.adDates = [...new Set((adsOut.data ?? []).map((r) => r.date as string))].sort().slice(0, 6);
    total = strays.ads;
  }

  if (total > 0 && body.acknowledgeStrays !== true) {
    return NextResponse.json({
      ok: false,
      code: "rows_left_outside",
      error: `${total} ad row(s) already filed to ${e.code} fall outside ${e.startDate} → ${e.endDate}${strays.adDates.length ? ` — spend on ${strays.adDates.join(", ")}` : ""}. Spend is filed to a round BY DATE, so those days would sit outside the window this round now claims. Nothing is re-filed; they keep ${e.code}.`,
      strays,
      override: "acknowledgeStrays",
    }, { status: 409 });
  }

  const { error: writeError } = await db.from("rounds").update({
    start_date: e.startDate,
    end_date: e.endDate,
    session_date: e.sessionDate || null,
    session_label: e.sessionLabel || null,
  }).eq("round_id", roundId).eq("client_id", clientId);
  if (writeError) return NextResponse.json({ ok: false, error: writeError.message }, { status: 500 });

  revalidatePath("/");
  revalidateTag(FUNNEL_TAG);

  return NextResponse.json({ ok: true, code: e.code, unchanged: verdict.unchanged, strays });
}
