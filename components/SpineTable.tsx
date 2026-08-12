import { SPINE, isGroup, fmt, roasClass, type Metrics } from "@/lib/funnel/spine";
import type { Cut } from "@/lib/funnel/data";

/**
 * Metrics down, variants across — the one table every comparison view uses.
 *
 * Baseline is a pinned column that never scrolls away; row labels freeze too.
 * A cell renders '—' whenever the database sent NULL. That decision was already
 * made in SQL (blank-vs-zero, zero-denom) — nothing here turns absence into 0.
 */
export function SpineTable({
  title, sub, notice, note, baseline, total, cuts,
}: {
  title: string;
  sub: string;
  notice?: React.ReactNode;
  note?: React.ReactNode;
  baseline: Cut | null;
  total: Cut | null;
  cuts: Cut[];
}) {
  const columns: Array<Cut & { isTotal?: boolean }> = [
    ...(total ? [{ ...total, isTotal: true }] : []),
    ...cuts,
  ];
  const base: Metrics = baseline?.m ?? {};

  return (
    <>
      <div className="cap">
        <b>{title}</b>
        <span>{sub}</span>
      </div>

      {notice ? (
        <div className="notice">
          <span className="ico">!</span>
          <div>{notice}</div>
        </div>
      ) : null}

      <div className="tw">
        <table className="spine">
          <colgroup>
            <col />
            <col className="base" />
            {columns.map((c) => (
              <col key={c.cut_key} className={c.isTotal ? "total" : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="lab">Metric</th>
              <th className="v">
                {baseline ? baseline.cut_label : "Baseline"}
                <span className="sub">baseline</span>
              </th>
              {columns.map((c) => (
                <th key={c.cut_key} className="v">
                  {c.cut_label}
                  {c.cut_sub ? <span className="sub">{c.cut_sub}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SPINE.map((row, i) => {
              if (isGroup(row)) {
                return (
                  <tr className="grp" key={`g${i}`}>
                    <td className="lab">{row.group}</td>
                    <td colSpan={columns.length + 1} />
                  </tr>
                );
              }
              const bv = fmt(base[row.key], row.fmt);
              return (
                <tr key={row.key}>
                  <td className="lab">{row.label}</td>
                  <td className="v base">{bv ?? "—"}</td>
                  {columns.map((c) => {
                    const raw = c.m?.[row.key];
                    const s = fmt(raw, row.fmt);
                    if (s === null) {
                      return (
                        <td className="v miss" key={c.cut_key}>
                          —
                        </td>
                      );
                    }
                    const hl = row.highlight
                      ? roasClass(raw, base[row.key], Boolean(c.isTotal))
                      : "";
                    return (
                      <td className={`v${hl}`} key={c.cut_key}>
                        {s}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="legend">
        <i>
          <span className="swatch" style={{ background: "var(--accent-wash)", border: "1px solid var(--line)" }} />
          Baseline — pinned, never scrolls away
        </i>
        <i>
          <span className="swatch" style={{ background: "var(--good)" }} /> ROAS ≥ 1.5× baseline
        </i>
        <i>
          <span className="swatch" style={{ background: "var(--bad)" }} /> ROAS &lt; 0.6× baseline
        </i>
        <i>— means the metric doesn&rsquo;t exist for this cut, not zero</i>
      </p>

      {note ? <p className="note">{note}</p> : null}
    </>
  );
}
