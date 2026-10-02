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
};
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
      setMarkets(data.markets?.length ? data.markets : ["SG"]);
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
  }

  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErrors([]); setProblem(null); setDone(null);
    try {
      const res = await fetch("/api/rounds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: client, code, startDate, endDate, sessionDate,
          sessionLabel: sessionDate ? `Class ${pretty(sessionDate)}` : "",
          productId, market,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data) { setProblem("The server did not answer in a shape this screen can read."); return; }
      if (data.errors) { setErrors(data.errors); return; }
      if (!data.ok) { setProblem(data.error ?? "That round was refused."); return; }
      setDone(data.created
        ? `${data.code} created. It can take imports now.`
        : `${data.code} already existed with these dates — nothing changed.`);
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
        <b>Add a round</b>
        <button type="button" className="linkish" onClick={() => setOpen(false)}>Close</button>
      </div>

      {rounds.length > 0 && (
        <p className="nr-ctx">
          Most recent: {rounds.slice(0, 3).map((r) => `${r.code ?? r.round_id} (${pretty(r.start_date)} → ${pretty(r.end_date)})`).join(" · ")}
        </p>
      )}

      <form onSubmit={submit}>
        <div className="nr-grid">
          <label>
            <span>Round code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="0926-05" />
            {errorFor("code") && <em>{errorFor("code")}</em>}
          </label>
          <label>
            <span>Product</span>
            <select value={productId} onChange={(e) => setProduct(e.target.value)}>
              <option value="">Choose…</option>
              {products.map((p) => <option key={p.product_id} value={p.product_id}>{p.product_name}</option>)}
            </select>
            {errorFor("productId") && <em>{errorFor("productId")}</em>}
          </label>
          <label>
            <span>Market</span>
            <select value={market} onChange={(e) => setMarket(e.target.value)}>
              <option value="">Choose…</option>
              {markets.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {errorFor("market") && <em>{errorFor("market")}</em>}
          </label>
          <label>
            <span>Starts</span>
            <input type="date" value={startDate} onChange={(e) => onStart(e.target.value)} />
            {errorFor("startDate") && <em>{errorFor("startDate")}</em>}
          </label>
          <label>
            <span>Ends</span>
            <input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
            {errorFor("endDate") && <em>{errorFor("endDate")}</em>}
          </label>
          <label>
            <span>Class date <i>optional</i></span>
            <input type="date" value={sessionDate} onChange={(e) => setSession(e.target.value)} />
            {errorFor("sessionDate") && <em>{errorFor("sessionDate")}</em>}
          </label>
        </div>

        <p className="nr-why">
          The dates decide which round a day of ad spend belongs to, so a wrong window doesn&rsquo;t
          fail — it files the money under the round next door. Overlapping rounds in one market are
          refused for the same reason.
        </p>

        {problem && <p className="nr-bad">{problem}</p>}
        {done && <p className="nr-ok">{done}</p>}

        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create round"}</button>
      </form>
    </div>
  );
}
