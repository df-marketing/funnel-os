"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * STEP 0, WHICH USED TO BE A SQL INSERT.
 *
 * Every other step of the import had a screen. This one said so in its own
 * copy — "Step 0 has no screen yet" — and the consequence was that adding a
 * round, a row with six fields, meant opening the Supabase editor.
 *
 * It opens closed. A round is created a few times a month and this pane is
 * passed on the way to the four that matter; a form standing permanently open
 * at the top of the import would be in the way far more often than it is wanted.
 *
 * WHAT IT REFUSES, IT REFUSES ON THE SERVER. lib/funnel/rounds.ts decides, the
 * route calls it, and this draws the answer. Nothing is validated only here —
 * a check that exists in the browser is a check anybody can skip, and the thing
 * being guarded is which round a day of money lands in.
 */

type Existing = {
  round_id: string; code: string | null;
  start_date: string; end_date: string;
  market: string | null; product_id: string | null;
  campaigns: string[] | null;
};
type Claimed = { campaign: string; code: string };
type Product = { product_id: string; product_name: string };
type FieldError = { field: string; message: string };

/** Last day of the week that starts on `start`, as the rounds mostly run. */
function weekFrom(start: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return "";
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

const pretty = (iso: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB",
        { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : "";

export function NewRoundForm({ client }: { client: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [rounds, setRounds] = useState<Existing[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [markets, setMarkets] = useState<string[]>([]);

  const [code, setCode] = useState("");
  const [startDate, setStart] = useState("");
  const [endDate, setEnd] = useState("");
  const [sessionDate, setSession] = useState("");
  const [productId, setProduct] = useState("");
  const [market, setMarket] = useState("");
  /* The campaign names this round owns, as typed. One per line, because that
     is how a column pastes out of Meta's export. Empty for a client whose
     rounds are consecutive weeks, which is every client but FWD i-Care. */
  const [campaigns, setCampaigns] = useState("");
  const [claimed, setClaimed] = useState<Claimed[]>([]);

  /* Which round is being edited, or null when adding. Editing reuses the same
     fields: it is the same six values, and two forms side by side would be two
     places for the date rules to drift apart. */
  const [editing, setEditing] = useState<string | null>(null);
  const [strays, setStrays] = useState<{ ads: number; events: number; adDates: string[] } | null>(null);

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/rounds?clientId=${encodeURIComponent(client)}`);
      const data = await res.json().catch(() => null);
      if (cancelled || !data?.ok) { setProblem("Could not read this client's rounds."); return; }
      setRounds(data.rounds ?? []);
      setProducts(data.products ?? []);
      setMarkets(data.markets ?? []);
      setClaimed(data.claimedCampaigns ?? []);
      setCode(data.suggested ?? "");
      if (data.products?.length === 1) setProduct(data.products[0].product_id);
      if (data.markets?.length === 1) setMarket(data.markets[0]);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [open, loaded, client]);

  /* The week and the class date follow the start, because every round so far is
     seven days with the class on the last. Both stay editable — this is the
     shape, not a rule, and 0826-02 ran fourteen days. */
  function onStart(value: string) {
    setStart(value);
    const end = weekFrom(value);
    if (end && !endDate) { setEnd(end); setSession(end); }
    /* The class is left alone once touched. Defaulting it to the last ads day
       is a guess that was right for Shely and wrong for anyone whose class is
       the day after — and that guess used to be enforced. */
  }

  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;

  /* A campaign already owned by ANOTHER round, read as it is typed. The server
     refuses this and so does a trigger on the table; this just means the
     operator finds out while looking at the field rather than after submitting.
     The round being edited is excluded, or it would collide with itself. */
  const collisions = (() => {
    const mine = new Set(campaigns.split(/[\n,]/).map((c) => c.trim().toLowerCase()).filter(Boolean));
    if (!mine.size) return [] as Claimed[];
    const out: Claimed[] = [];
    const seen = new Set<string>();
    for (const c of claimed) {
      const key = c.campaign.trim().toLowerCase();
      if (!mine.has(key) || c.code === editing || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  })();

  function startEdit(r: Existing) {
    setEditing(r.code ?? r.round_id);
    setCode(r.code ?? r.round_id);
    setStart(r.start_date);
    setEnd(r.end_date);
    setSession("");
    setProduct(r.product_id ?? "");
    setMarket((r.market ?? "").toUpperCase());
    setCampaigns((r.campaigns ?? []).join("\n"));
    setErrors([]); setProblem(null); setDone(null); setStrays(null);
  }

  function reset() {
    setEditing(null); setStrays(null); setErrors([]); setProblem(null); setDone(null);
    setStart(""); setEnd(""); setSession(""); setCampaigns("");
  }

  async function submit(e: React.FormEvent, acknowledgeStrays = false) {
    e.preventDefault();
    setBusy(true); setErrors([]); setProblem(null); setDone(null);
    if (!acknowledgeStrays) setStrays(null);
    try {
      const res = await fetch("/api/rounds", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: client, code, startDate, endDate, sessionDate,
          sessionLabel: sessionDate ? `Class ${pretty(sessionDate)}` : "",
          productId, market, campaigns,
          ...(acknowledgeStrays ? { acknowledgeStrays: true } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data) { setProblem("The server did not answer in a shape this screen can read."); return; }
      if (data.errors) { setErrors(data.errors); return; }
      if (!data.ok) {
        /* Rows already filed here that the new window would not cover. Not an
           error — a thing to be told before it happens, with the override in
           the same place as the message. */
        if (data.code === "rows_left_outside") setStrays(data.strays ?? null);
        setProblem(data.error ?? "That round was refused.");
        return;
      }
      setDone(editing
        ? `${data.code} updated${data.unchanged ? " — the dates were already these" : ""}.`
        : data.created
          ? `${data.code} created. It can take imports now.`
          : `${data.code} already existed with these dates — nothing changed.`);
      reset();
      setLoaded(false);           // re-read, so the list and suggestion move on
      router.refresh();
    } catch {
      setProblem("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="notice">
        <span className="ico">0</span>
        <div>
          <b>Rounds are set up once per round.</b> An import is refused outright if the round it
          belongs to doesn&rsquo;t exist — attendance names a <span className="num">round_id</span>{" "}
          like <span className="num">0826-01</span>, and there has to be a row to attach it to.{" "}
          <button type="button" className="linkish" onClick={() => setOpen(true)}>
            Add a round
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="newround">
      <div className="nr-h">
        <b>{editing ? `Edit ${editing}` : "Add a round"}</b>
        <button type="button" className="linkish"
          onClick={() => { if (editing) reset(); else setOpen(false); }}>
          {editing ? "Cancel" : "Close"}
        </button>
      </div>

      {rounds.length > 0 && (
        <div className="nr-list">
          {rounds.slice(0, 6).map((r) => {
            const c = r.code ?? r.round_id;
            return (
              <span key={c} className={c === editing ? "nr-pill on" : "nr-pill"}>
                <span className="nr-code">{c}</span>
                <span className="nr-win">{pretty(r.start_date)} → {pretty(r.end_date)}</span>
                <button type="button" className="linkish" onClick={() => startEdit(r)}>edit</button>
              </span>
            );
          })}
        </div>
      )}

      <form onSubmit={submit}>
        <div className="nr-grid">
          <label>
            <span>Round code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)}
              placeholder="0926-05" readOnly={!!editing}
              title={editing ? "A round's code is its identity — create a new one instead of renaming" : undefined} />
            {errorFor("code") && <em>{errorFor("code")}</em>}
          </label>
          <label>
            <span>Product</span>
            <select value={productId} onChange={(e) => setProduct(e.target.value)} disabled={!!editing}>
              <option value="">Choose…</option>
              {products.map((p) => <option key={p.product_id} value={p.product_id}>{p.product_name}</option>)}
            </select>
            {errorFor("productId") && <em>{errorFor("productId")}</em>}
          </label>
          <label>
            <span>Market</span>
            <select value={market} onChange={(e) => setMarket(e.target.value)} disabled={!!editing}>
              <option value="">Choose…</option>
              {markets.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {errorFor("market") && <em>{errorFor("market")}</em>}
          </label>
          <label>
            <span>Ads start</span>
            <input type="date" value={startDate} onChange={(e) => onStart(e.target.value)} />
            {errorFor("startDate") && <em>{errorFor("startDate")}</em>}
          </label>
          <label>
            <span>Ads end</span>
            <input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
            {errorFor("endDate") && <em>{errorFor("endDate")}</em>}
          </label>
          <label>
            <span>Class date <i>any date</i></span>
            <input type="date" value={sessionDate} onChange={(e) => setSession(e.target.value)} />
            {errorFor("sessionDate") && <em>{errorFor("sessionDate")}</em>}
          </label>
        </div>

        {/* CAMPAIGNS THIS ROUND OWNS.
            
            Only needed by a client whose rounds run AT THE SAME TIME, so it is
            last and it is optional. FWD i-Care's three rounds are three
            concurrent experiments over one window — 1 Jul to 6 Oct, all three
            — and the campaign name is the only thing that tells them apart.
            Shely's rounds are consecutive weeks and need none of this.
            
            A textarea rather than a tag input because the names are long and
            arrive as a pasted column. */}
        <label className="nr-wide">
          <span>Campaigns this round owns <i>only if rounds overlap</i></span>
          <textarea rows={3} value={campaigns} spellCheck={false}
            placeholder={"One campaign name per line, exactly as Meta writes it\nFWD_iCareChi_META_MOFU_Sales_2026_40To49"}
            onChange={(e) => setCampaigns(e.target.value)} />
          {errorFor("campaigns") && <em>{errorFor("campaigns")}</em>}
        </label>
        {collisions.length > 0 && (
          <p className="nr-bad">
            {collisions.length === 1 ? "That campaign is" : "Those campaigns are"} already owned by{" "}
            {[...new Set(collisions.map((c) => c.code))].join(", ")}:{" "}
            {collisions.map((c) => c.campaign).join(", ")}. A campaign belongs to one round.
          </p>
        )}

        <p className="nr-why">
          {editing
            ? "Changing the ads window does not move rows that are already imported — they keep this round. It changes which round a FUTURE import files a day to, and it can leave existing rows outside the window."
            : "The ads dates decide which round a day of spend belongs to, so a wrong window doesn’t fail — it files the money under the round next door. Only those two dates are checked for overlap."}
          {" "}The class runs on its own schedule: it can be after the ads stop, or on the same day the next round’s ads begin.
          {" "}Two rounds may share a window only if both name the campaigns they own.
        </p>

        {problem && <p className="nr-bad">{problem}</p>}
        {strays && (
          <p className="nr-warn">
            Nothing is re-filed — those rows keep {code}. They will simply sit outside the window it
            now claims.{" "}
            <button type="button" className="linkish" disabled={busy}
              onClick={(e) => submit(e, true)}>
              Change the dates anyway
            </button>
          </p>
        )}
        {done && <p className="nr-ok">{done}</p>}

        <button type="submit" disabled={busy}>
          {busy ? (editing ? "Saving…" : "Creating…") : (editing ? "Save dates" : "Create round")}
        </button>
      </form>
    </div>
  );
}
