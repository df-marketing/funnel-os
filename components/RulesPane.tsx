"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RULE_OPS, RULE_FIELDS, TARGETS,
  type DimensionRow, type Proposal, type Rule, type RuleField, type RuleOp, type Target,
} from "@/lib/funnel/rules";

/**
 * REQUIREMENT 3 — adding a source without writing SQL.
 *
 * The engine has resolved five dimensions from rules since 0073. The only thing
 * missing was a way in that was not a hand-written INSERT, which is fine for one
 * client and stops being fine at the second.
 *
 * The screen leads with what the data already says. Opening on an empty form
 * would ask somebody to know the campaign naming convention by heart; opening on
 * "437 rows arrived with source affiliate_partner, which no rule names yet"
 * asks them to confirm something they can check.
 *
 * ORDER IS THE PRIORITY, and it is shown rather than explained. The first value
 * whose rules match wins, so the list is the algorithm — which is why the ord
 * column is visible and editable rather than hidden behind a drag handle that
 * would imply a stable sort nobody guaranteed.
 */

const TARGET_LABELS: Record<Target, [string, string]> = {
  source:       ["Source", "Where a lead came from. The one dimension that can be read from the export's own source column, which is what makes affiliate work without a tracking parameter."],
  market:       ["Market", "Which country a campaign ran in. Read from the campaign name."],
  landing_page: ["Landing page", "Which page a campaign pointed at. A campaign with no page is a lead form."],
  product:      ["Product", "Which offer a campaign was selling."],
  channel:      ["Channel", "Which platform the money was spent on."],
};

const OP_LABELS: Record<RuleOp, string> = {
  contains: "contains", not_contains: "does not contain", is: "is exactly", is_not: "is not",
  starts_with: "starts with", ends_with: "ends with", is_empty: "is empty",
  is_not_empty: "is not empty", one_of: "is one of (comma separated)", regex: "matches regex",
};

const FIELD_LABELS: Record<RuleField, string> = {
  campaign: "campaign name", ad_set: "ad set (utm_term)", ad: "ad (utm_content)", source: "source column",
};

/* ruleOk defaults an absent field to campaign and an absent op to contains, so
   a stored rule may legally carry neither. The screen applies the SAME defaults
   — anything else would draw a rule that differs from the one that runs. */
const fieldOf = (r: Rule): RuleField => r.field ?? "campaign";
const opOf = (r: Rule): RuleOp => r.op ?? "contains";
const needsValue = (op: RuleOp) => op !== "is_empty" && op !== "is_not_empty";
const blank = (): Rule => ({ op: "contains", field: "campaign", value: "" });

export function RulesPane({ client }: { client: string }) {
  const [target, setTarget] = useState<Target>("source");
  const [values, setValues] = useState<DimensionRow[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [scan, setScan] = useState<{ truncated: boolean; campaigns: number; sources: number } | null>(null);
  const [draft, setDraft] = useState<{ key: string; label: string; rules: Rule[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    setError(null);
    const [a, b] = await Promise.all([
      fetch(`/api/rules?client=${encodeURIComponent(client)}&target=${target}`).then((r) => r.json()),
      fetch(`/api/rules/propose?client=${encodeURIComponent(client)}&target=${target}`).then((r) => r.json()),
    ]);
    if (!a.ok) { setError(a.error); return; }
    setValues(a.values ?? []);
    if (b.ok) {
      setProposals(b.proposals ?? []);
      setScan({ truncated: !!b.truncated, campaigns: b.scanned?.campaigns ?? 0, sources: b.scanned?.sources ?? 0 });
    }
  }, [client, target]);

  useEffect(() => { void load(); }, [load]);

  async function save(body: Record<string, unknown>) {
    setBusy(true); setError(null); setSaid(null);
    const res = await fetch("/api/rules", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: client, target, ...body }),
    }).then((r) => r.json());
    setBusy(false);
    if (!res.ok) { setError(res.error); return false; }
    /* The cache is dropped server-side on save; this refreshes what is on
       screen behind the pane so the new column is there when they navigate,
       rather than thirty minutes later. */
    setSaid(`Saved. Every past round now answers to this rule — nothing to re-import.`);
    await load();
    router.refresh();
    return true;
  }

  async function remove(v: DimensionRow) {
    if (!confirm(`Delete '${v.key}'? Rows it explained will fall through to the next matching rule.`)) return;
    setBusy(true); setError(null); setSaid(null);
    const res = await fetch(`/api/rules?id=${encodeURIComponent(v.id!)}`, { method: "DELETE" }).then((r) => r.json());
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    await load();
    router.refresh();
  }

  const [title, blurb] = TARGET_LABELS[target];

  return (
    <div className="rules-pane">
      <div className="pane-head">
        <div className="tabs">
          {TARGETS.map((t) => (
            <button key={t} type="button"
              className={`btn${t === target ? " primary" : ""}`}
              onClick={() => { setTarget(t); setDraft(null); setSaid(null); setError(null); }}>
              {TARGET_LABELS[t][0]}
            </button>
          ))}
        </div>
      </div>

      <p className="dim">{blurb}</p>

      {error ? <p className="notice">{error}</p> : null}
      {said ? <p className="notice info">{said}</p> : null}

      {/* ── what the data already says ─────────────────────────────────── */}
      <h3>What your data suggests</h3>
      {scan?.truncated ? (
        <p className="notice">
          Scanned the first {scan.campaigns} campaigns and {scan.sources} source values — there are more.
          Anything below is real; this is not the whole picture.
        </p>
      ) : null}

      {proposals.length === 0 ? (
        <p className="none">
          Nothing unexplained. Every campaign and source this client has is already
          matched by a rule below.
        </p>
      ) : (
        <ul className="proposals">
          {proposals.map((p, i) => (
            <li key={`${p.rule.field}:${p.rule.value}:${i}`}>
              <div>
                <b>{p.label}</b>
                <span className="dim"> — {p.why}</span>
                <div className="sub">
                  {FIELD_LABELS[p.rule.field]} {OP_LABELS[p.rule.op]} <code>{p.rule.value}</code>
                  {p.samples.length ? <span className="dim"> · e.g. {p.samples.join(", ")}</span> : null}
                </div>
              </div>
              <button className="btn primary" type="button" disabled={busy}
                onClick={() => save({ key: p.key, label: p.label, rules: [p.rule] })}>
                Create {p.key}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ── the rules as they stand ────────────────────────────────────── */}
      <h3>{title} values, in the order they are checked</h3>
      {values.length === 0 ? (
        <p className="none">No {title.toLowerCase()} rules yet. Everything resolves to nothing.</p>
      ) : (
        <table className="rules-table">
          <thead>
            <tr><th>Order</th><th>Key</th><th>Matches when</th><th /></tr>
          </thead>
          <tbody>
            {values.map((v) => (
              <tr key={v.id}>
                <td className="num">{v.ord}</td>
                <td>
                  <b>{v.key}</b>
                  {v.label && v.label !== v.key ? <span className="dim"> {v.label}</span> : null}
                  {v.flags?.catch_all ? <span className="badge">catch-all</span> : null}
                  {v.flags?.none ? <span className="badge">not a {title.toLowerCase()}</span> : null}
                  {v.note ? <div className="sub dim">{v.note}</div> : null}
                </td>
                <td>
                  {v.rules.length === 0 ? (
                    <span className="dim">anything that reached it</span>
                  ) : (
                    v.rules.map((r, i) => (
                      <div key={i} className="sub">
                        {i > 0 ? <span className="dim">or </span> : null}
                        {FIELD_LABELS[fieldOf(r)]} {OP_LABELS[opOf(r)]}
                        {needsValue(opOf(r)) ? <> <code>{r.value}</code></> : null}
                      </div>
                    ))
                  )}
                </td>
                <td>
                  <button className="btn" type="button" disabled={busy} onClick={() => remove(v)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ── the fallback, not the path ─────────────────────────────────── */}
      <h3>Write one by hand</h3>
      {!draft ? (
        <button className="btn" type="button" onClick={() => setDraft({ key: "", label: "", rules: [blank()] })}>
          Add a {title.toLowerCase()} value
        </button>
      ) : (
        <div className="rule-draft">
          <label>Key <input value={draft.key} maxLength={40}
            onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></label>
          <label>Label <input value={draft.label} maxLength={80}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>

          {draft.rules.map((r, i) => (
            <div key={i} className="rule-row">
              <select value={fieldOf(r)} onChange={(e) => {
                const rules = [...draft.rules]; rules[i] = { ...r, field: e.target.value as RuleField };
                setDraft({ ...draft, rules });
              }}>
                {RULE_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
              </select>
              <select value={opOf(r)} onChange={(e) => {
                const rules = [...draft.rules]; rules[i] = { ...r, op: e.target.value as RuleOp };
                setDraft({ ...draft, rules });
              }}>
                {RULE_OPS.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
              </select>
              {needsValue(opOf(r)) ? (
                <input value={r.value} placeholder="value" onChange={(e) => {
                  const rules = [...draft.rules]; rules[i] = { ...r, value: e.target.value };
                  setDraft({ ...draft, rules });
                }} />
              ) : null}
              {draft.rules.length > 1 ? (
                <button className="btn" type="button"
                  onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}>−</button>
              ) : null}
            </div>
          ))}

          {/* Clauses are OR, matching fo_resolve: the value wins if ANY of its
              rules matches. Said here because the opposite is the usual guess. */}
          <p className="sub dim">Any one of these matching is enough.</p>

          <div className="rule-actions">
            <button className="btn" type="button"
              onClick={() => setDraft({ ...draft, rules: [...draft.rules, blank()] })}>Add a clause</button>
            <button className="btn primary" type="button" disabled={busy}
              onClick={async () => { if (await save(draft)) setDraft(null); }}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn" type="button" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
