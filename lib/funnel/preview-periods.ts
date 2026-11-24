import { cadencesFor, type Cadence } from "./cadence";
import { listOf, windowKey } from "./filters";

type Period = { key: string; label: string; from: string | null; to: string | null };
type ProductCadence = { product_id: string; cadence?: Cadence | null };

/** Period filters carry day windows, not round IDs. Same-anchor rounds share one truthful option. */
export function previewPeriodChoices(periods: readonly Period[]): { key: string; label: string }[] {
  const groups = new Map<string, Set<string>>();
  for (const p of periods) {
    if (!p.key.startsWith("r:") || !p.from || p.from !== p.to) continue;
    const ids = groups.get(p.from) ?? new Set<string>();
    ids.add(p.key);
    groups.set(p.from, ids);
  }
  const emitted = new Set<string>();
  return periods.flatMap((p) => {
    if (!p.from || !p.to) return [];
    const count = p.key.startsWith("r:") && p.from === p.to ? (groups.get(p.from)?.size ?? 0) : 0;
    const key = windowKey(p.from, p.to);
    if (count) {
      if (emitted.has(key)) return [];
      emitted.add(key);
      if (count > 1) return [{ key, label: `${p.from} (${count} rounds share this date)` }];
    }
    return [{ key, label: p.label }];
  });
}

/** Match the same comma-separated product set as the data filter. */
export function previewCadencesFor(products: readonly ProductCadence[], product: string | null): Cadence[] {
  const selected = new Set(listOf(product));
  return cadencesFor(products.filter((p) => !selected.size || selected.has(p.product_id)), null);
}
