import Link from "next/link";
import { fmtCount } from "@/lib/funnel/spine";
import { RefreshButton } from "./RefreshButton";
import { SOURCES, type SourceKey } from "@/lib/import/sources";
import type { Client, Stage, StripCard, ImportStatus } from "@/lib/funnel/data";

const href = (client: string, view: string) => `/?client=${client}&view=${view}`;

/** Views that exist regardless of the client's journey. */
export const FIXED_VIEWS = ["import", "unmatched", "month", "round", "source", "roundsource", "analysis"];

/** Which tabs are wired to real Supabase data today. Everything else says so. */
export const WIRED = new Set([
  "month", "round", "source", "roundsource",
  "targeting", "ads", "class", "preview", "middle",
  "analysis", "import", "unmatched",
]);

export function TopBar({
  clients, current, imports,
}: {
  clients: Client[];
  current: Client;
  imports: ImportStatus[];
}) {
  const stale = imports.filter((i) => i.is_stale);
  /**
   * A source that has NEVER been imported has no batch, so it has no last-import
   * date, so it can't be stale — and the header used to read "All sources
   * current" while Sales said "never" on the tab below it. Absence was passing
   * as freshness. Missing is a louder problem than stale, so it's said first.
   */
  const missing = (Object.keys(SOURCES) as SourceKey[]).filter(
    (k) => !imports.some((i) => i.source === k),
  );
  const coverage = imports
    .map((i) => i.coverage_end)
    .filter(Boolean)
    .sort() as string[];
  const span = coverage.length
    // rendered on the server, so the zone is named rather than inherited — see
    // the note on `when` in DataPanes
    ? new Date(coverage[coverage.length - 1]).toLocaleDateString("en-SG", {
        month: "short", year: "numeric", timeZone: "Asia/Singapore",
      })
    : "—";

  return (
    <div className="top">
      <div className="brand">
        <b>Funnel OS</b>
        <span>{current.client_name ?? current.client_id}</span>
      </div>

      {/* Client switcher — driven entirely by client_journey_config */}
      <div className="seg" role="group" aria-label="Client">
        {clients.map((c) => (
          <Link
            key={c.client_id}
            href={href(c.client_id, "round")}
            aria-pressed={c.client_id === current.client_id}
          >
            {c.client_name ?? c.client_id}
          </Link>
        ))}
      </div>

      <span className="meta">{current.client_note}</span>
      <div className="spacer" />

      {/* Staleness is surfaced in the header and propagates to every view below */}
      {missing.length || stale.length ? (
        <>
          {missing.map((k) => (
            <span className="meta fresh" key={k}>
              <span className="dot old" />
              {SOURCES[k].label} never imported
            </span>
          ))}
          {stale.map((s) => (
            <span className="meta fresh" key={s.source}>
              <span className="dot old" />
              {s.source[0].toUpperCase() + s.source.slice(1)}
              {s.days_behind ? ` ${s.days_behind}d` : ""} stale
            </span>
          ))}
        </>
      ) : (
        <span className="meta fresh">
          <span className="dot ok" />
          All sources current
        </span>
      )}
      <span className="meta">
        through {span} · <b>SGD</b>
      </span>
      <RefreshButton />
    </div>
  );
}

export function JourneyStrip({
  strip, client, view,
}: {
  strip: StripCard[];
  client: string;
  view: string;
}) {
  return (
    <section className="journey">
      <div className="journey-head">
        <h2>Customer journey</h2>
        <p>Each stage has a comparison view. Change the journey and the views change with it.</p>
      </div>
      <div className="stages">
        {strip.map((s) => (
          <Link
            className="stage"
            key={s.stage_slug}
            href={href(client, s.stage_slug)}
            aria-current={view === s.stage_slug}
          >
            <span className="sname">{s.stage_name}</span>
            <span className="sval">{fmtCount(s.value)}</span>
            <span className="srate">
              {s.rate !== null && s.rate !== undefined
                ? `${Number(s.rate).toFixed(1)}% ${s.stage_rate_label ?? ""}`.trim()
                : (s.stage_rate_label ?? "")}
            </span>
            <span className="sarrow" />
          </Link>
        ))}
      </div>
    </section>
  );
}

export function SideNav({
  stages, client, view, unmatchedCount,
}: {
  stages: Stage[];
  client: string;
  view: string;
  unmatchedCount: number;
}) {
  const item = (slug: string, label: React.ReactNode) => (
    <Link key={slug} href={href(client, slug)} aria-current={view === slug ? "page" : undefined}>
      {label}
    </Link>
  );

  return (
    <nav className="nav">
      <div className="nav-group">Data</div>
      {item("import", "Import")}
      {item(
        "unmatched",
        <>
          Unmatched {unmatchedCount ? <span className="badge">{unmatchedCount}</span> : null}
        </>,
      )}

      <div className="nav-group">Overview</div>
      {item("month", "By month")}
      {item("round", "By round")}
      {item("source", "By source")}
      {item("roundsource", "Round × source")}

      <div className="nav-group">
        Compare <span className="derived">one per journey stage</span>
      </div>
      {stages.map((s) => item(s.stage_slug, s.stage_name))}

      <div className="nav-group">Now</div>
      {item("analysis", "This round")}
    </nav>
  );
}

export function NotWired({ title, blurb, reason }: { title: string; blurb: string; reason: string }) {
  return (
    <>
      <div className="pane-head">
        <h1>{title}</h1>
        <p>{blurb}</p>
      </div>
      <div className="notice info">
        <span className="ico">?</span>
        <div>
          <b>Not wired yet.</b> {reason} The nav, the journey strip and the metric spine are the same
          engine as the wired views — this tab needs its cut defined, not new machinery.
        </div>
      </div>
    </>
  );
}
