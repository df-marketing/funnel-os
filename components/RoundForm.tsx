"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  validateRound, defaultSessionLabel, suggestRoundId,
  type ExistingRound, type Problem,
} from "@/lib/rounds/validate";

/**
 * STEP 0, WHICH HAD NO SCREEN.
 *
 * A round had to exist before anything could be imported into it, and the only
 * way to make one was a hand-written SQL insert. Every other step on this tab
 * was a drop zone; the first one was a note apologising for itself.
 *
 * The same rules run here and on the server. Here they name the problem while
 * you type, which is the point of having them; there they are the ones that
 * actually decide, because a client-side check is a courtesy and not a guard.
 */

type Product = { product_id: string; product_name: string };

const today = () => new Date().toISOString().slice(0, 10);
const plus = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export function RoundForm({
  client, rounds, products,
}: {
  client: string;
  rounds: ExistingRound[];
  products: Product[];
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const router = useRouter();

  // Opens on the day after the last round ends, which is where the next one
  // almost always starts — and, not by accident, cannot overlap it.
  const last = [...rounds].sort((a, b) => a.end_date.localeCompare(b.end_date)).at(-1);
  const start = last ? plus(last.end_date, 1) : today();
  const [form, setForm] = useState(() => ({
    round_id: suggestRoundId(plus(start, 6).slice(0, 7), rounds),
    start_date: start,
    end_date: plus(start, 6),
    session_date: plus(start, 6),
    session_label: defaultSessionLabel(plus(start, 6)),
    product_id: products[0]?.product_id ?? "",
  }));

  const set = (patch: Partial<typeof form>) =>
    setForm((f) => {
      const next = { ...f, ...patch };
      // The class is nearly always the last day, and its label is its date.
      // Both stay in step until somebody types over them.
      if (patch.end_date && f.session_date === f.end_date) {
        next.session_date = patch.end_date;
      }
      if (next.session_date !== f.session_date && f.session_label === defaultSessionLabel(f.session_date)) {
        next.session_label = defaultSessionLabel(next.session_date);
      }
      return next;
    });

  const problems: Problem[] = validateRound(
    { ...form, client_id: client, product_id: form.product_id || null,
      session_date: form.session_date || null, session_label: form.session_label || null },
    rounds.filter((r) => r.round_id !== form.round_id),
  );
  const problemFor = (field: string) => problems.find((p) => p.field === field);

  async function save() {
    setSaving(true); setFailed(null);
    try {
      const res = await fetch("/api/rounds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, client_id: client }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setFailed(body.problems?.[0]?.message ?? body.note ?? "That round couldn't be saved.");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setFailed("Couldn't reach the server just now — try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="round-form">
        <button className="btn" onClick={() => setOpen(true)}>Add a round</button>
        <p className="dim round-form-hint">
          {rounds.length
            ? `${rounds.length} round${rounds.length === 1 ? "" : "s"} so far, last one ending ${last?.end_date}.`
            : "No rounds yet. Nothing can be imported until one exists."}
        </p>
      </div>
    );
  }

  return (
    <div className="round-form open">
      <div className="round-grid">
        <label>
          <span>Round</span>
          <input value={form.round_id} onChange={(e) => set({ round_id: e.target.value.trim() })}
                 placeholder="0926-01" />
        </label>
        <label>
          <span>Product</span>
          <select value={form.product_id} onChange={(e) => set({ product_id: e.target.value })}>
            <option value="">—</option>
            {products.map((p) => (
              <option key={p.product_id} value={p.product_id}>{p.product_name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Ads run from</span>
          <input type="date" value={form.start_date}
                 onChange={(e) => set({ start_date: e.target.value })} />
        </label>
        <label>
          <span>to</span>
          <input type="date" value={form.end_date}
                 onChange={(e) => set({ end_date: e.target.value })} />
        </label>
        <label>
          <span>Class day</span>
          <input type="date" value={form.session_date}
                 onChange={(e) => set({ session_date: e.target.value })} />
        </label>
        <label>
          <span>Class called</span>
          <input value={form.session_label}
                 onChange={(e) => set({ session_label: e.target.value })} />
        </label>
      </div>

      {/*
        Every one of these is a fault the hand-written SQL had to go back and fix
        — a class day outside its own round, a round with no product, two rounds
        covering the same day. Saying so while you type is the whole reason this
        screen is better than the insert it replaces.
      */}
      {problems.length > 0 && (
        <ul className="round-problems">
          {problems.map((p) => <li key={p.field + p.message}>{p.message}</li>)}
        </ul>
      )}
      {failed && (
        <div className="notice warn"><span className="ico">!</span><div>{failed}</div></div>
      )}

      <p className="dim round-form-hint">
        The window is the ad flight, extended to take in the class day — that is
        the rule the existing rounds follow. A day of spend belongs to the round
        whose window holds it, so the windows must not overlap.
      </p>

      <div className="round-actions">
        <button className="btn primary" disabled={problems.length > 0 || saving} onClick={save}>
          {saving ? "Saving…" : "Create round"}
        </button>
        <button className="btn" onClick={() => { setOpen(false); setFailed(null); }}>Cancel</button>
      </div>
    </div>
  );
}
