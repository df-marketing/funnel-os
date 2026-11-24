"use client";

import { useEffect, useState } from "react";
import type { MappingProfile, ProfileDateRule } from "@/lib/import/mapping-profile";
import { leadDateBlock, type LeadOptInDate, type LeadRoundMatches, type RoundTagEvidence } from "@/lib/import/lead-round-evidence";
import { LeadRoundEvidence } from "./LeadRoundEvidence";

export type ImportMappingView = {
  kind: "mapping"; source: string; label: string; headers: string[];
  fields: { field: string; required: boolean }[];
  automatic: Record<string, string>; missing: string[]; broken: string[];
  stages: { slug: string; label: string; binding: string }[];
  fallbackBinding: string; profileEnabled: boolean;
  roundTagEvidence?: RoundTagEvidence | null;
  roundMatches?: LeadRoundMatches;
  leadDate?: LeadOptInDate;
};
type Saved = { id: string; revision: number; profile: MappingProfile; matches: boolean };
export type ConfirmedReview = {
  stageSlug: string | null; binding: string;
} & ({ profile: MappingProfile } | { selected: { id: string; revision: number } });
type Choice = { slug: string | null; binding: string };

const fromForm = (value: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(value).filter(([, header]) => Boolean(header)));

const displayField = (field: string) => field.replace(/^ad_measure:/, "Ad measure: ").replaceAll("_", " ");

export function ImportMappingReview({
  view, client, onPreview, onStartOver, worksheet,
}: {
  view: ImportMappingView; client: string; worksheet?: string;
  onPreview: (review?: ConfirmedReview) => void; onStartOver: () => void;
}) {
  const [stage, setStage] = useState<Choice | null>(() => view.stages.length === 0
    ? { slug: null, binding: view.fallbackBinding }
    : view.stages.length === 1 ? view.stages[0] : null);
  const [mapping, setMapping] = useState(view.automatic);
  const [dateOrder, setDateOrder] = useState<ProfileDateRule>("auto");
  const [manual, setManual] = useState(false);
  const [name, setName] = useState("");
  const [profiles, setProfiles] = useState<Saved[]>([]);
  const [inspected, setInspected] = useState<Saved | null>(null);
  const [selected, setSelected] = useState<Saved | null>(null);
  const [profileNotice, setProfileNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  // Read-only suggestions, never automatic application. Abort stale scope reads.
  useEffect(() => {
    if (!stage?.slug || !view.profileEnabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/import/profiles", {
          method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ action: "list", clientId: client, source: view.source,
            stageSlug: stage.slug, binding: stage.binding, headers: view.headers }),
        });
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setProfiles([]);
          setProfileNotice(body.error ?? "Could not load saved profiles.");
          return;
        }
        setProfiles(body.profiles);
      } catch {
        if (!controller.signal.aborted) setProfileNotice("Could not load saved profiles.");
      }
    })();
    return () => controller.abort();
  }, [stage, client, view.source, view.headers, view.profileEnabled, reload]);

  function payload(profileName: string, choice: Choice): MappingProfile {
    return { clientId: client, source: view.source as MappingProfile["source"], stageSlug: choice.slug,
      name: profileName, headers: view.headers, mapping: fromForm(mapping), rules: { dateOrder } };
  }

  const ready = view.fields.every((field) => !field.required || Boolean(mapping[field.field]));
  const dateBlock = view.source === "leads" ? leadDateBlock(view.leadDate, mapping.event_date) : null;
  const completeManual = ready && Object.values(fromForm(mapping)).length === new Set(Object.values(fromForm(mapping))).size;

  async function save(update: boolean) {
    if (!stage?.slug || !name.trim() || !completeManual || busy || (update && !inspected)) return;
    setBusy(true);
    setProfileNotice("");
    try {
      const response = await fetch("/api/import/profiles", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: update ? "update" : "create", clientId: client, source: view.source,
          stageSlug: stage.slug, binding: stage.binding, profile: payload(name, stage),
          ...(update && inspected ? { id: inspected.id, revision: inspected.revision } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save the mapping profile.");
      if (selected && update && inspected?.id === selected.id) {
        setSelected(null);
        setManual(true);
      }
      setInspected(null);
      setProfileNotice(update ? "Mapping profile updated." : "Mapping profile saved.");
      setReload((n) => n + 1);
    } catch (error) {
      setProfileNotice(error instanceof Error ? error.message : "Could not save the mapping profile.");
    } finally {
      setBusy(false);
    }
  }

  function apply(saved: Saved) {
    if (!saved.matches) return;
    setMapping({ ...saved.profile.mapping });
    setDateOrder(saved.profile.rules.dateOrder);
    setName(saved.profile.name);
    setSelected(saved);
    setInspected(saved);
    setManual(true);
  }

  function preview() {
    if (busy || dateBlock) return;
    if (!manual) return onPreview();
    if (!stage || !completeManual) return;
    const scope = { stageSlug: stage.slug, binding: stage.binding };
    onPreview(selected
      ? { ...scope, selected: { id: selected.id, revision: selected.revision } }
      : { ...scope, profile: payload("Manual import mapping", stage) });
  }

  return (
    <div className="diff" style={{ display: "grid", gap: 12 }}>
      <b>Review the {view.label.toLowerCase()} mapping{worksheet ? ` · ${worksheet}` : ""}</b>
      <p className="dim">Automatic mapping is shown first. If a heading is unfamiliar, pick the right file column. Nothing is staged until you choose Preview.</p>
      {view.roundTagEvidence ? <LeadRoundEvidence evidence={view.roundTagEvidence} matches={view.roundMatches} /> : null}
      {dateBlock ? <div role="status" className="notice">{dateBlock}</div> : null}
      {view.broken.length ? <div role="status">Changed since the last import: {view.broken.join("; ")}</div> : null}
      {view.missing.length && !manual ? <div role="status">Not matched automatically: {view.missing.map(displayField).join(", ")}.</div> : null}
      {view.stages.length > 0 ? (
        <label>
          Journey stage{" "}
          <select disabled={busy} value={stage?.slug ?? ""} onChange={(event) => {
            setStage(view.stages.find((choice) => choice.slug === event.target.value) ?? null);
            setSelected(null); setInspected(null); setProfiles([]); setProfileNotice("");
            setName(""); setMapping(view.automatic); setDateOrder("auto"); setManual(false);
          }}>
            <option value="">Choose a configured stage</option>
            {view.stages.map((choice) => <option key={choice.binding} value={choice.slug}>{choice.label}</option>)}
          </select>
        </label>
      ) : null}
      <div style={{ display: "grid", gap: 6 }}>
        {view.fields.map(({ field, required }) => (
          <label key={field} style={{ display: "grid", gridTemplateColumns: "minmax(100px, 1fr) minmax(140px, 1fr)", gap: 8 }}>
            <span>{displayField(field)}{required ? " (required)" : ""}</span>
            <select disabled={busy} value={mapping[field] ?? ""} onChange={(event) => {
              const next = event.currentTarget.value;
              setMapping((m) => ({ ...m, [field]: next }));
              setManual(true);
              setSelected(null);
            }}>
              <option value="">Not mapped</option>
              {view.headers.filter(Boolean).map((header, index) => <option key={index} value={header}>{header}</option>)}
            </select>
          </label>
        ))}
      </div>
      <label>
        Date format{" "}
        <select disabled={busy} value={dateOrder} onChange={(event) => {
          setDateOrder(event.currentTarget.value as ProfileDateRule); setSelected(null); setManual(true);
        }}>
          <option value="auto">Automatic (existing importer)</option>
          <option value="dmy">Day / month / year</option>
          <option value="mdy">Month / day / year</option>
        </select>
      </label>
      {manual && view.source === "leads" ? <p className="dim">Reviewed mappings do not import additional columns as Form Answers. Use automatic mapping for contacts or Form Answers exports.</p> : null}
      {manual && (!stage || !completeManual) ? <div role="status">Choose a stage if listed and map every required field to a different file column.</div> : null}
      {manual ? <button type="button" className="linkish" disabled={busy} onClick={() => {
        setManual(false); setSelected(null); setMapping(view.automatic); setDateOrder("auto");
      }}>Reset to automatic mapping</button> : null}
      <fieldset style={{ display: "grid", gap: 8 }}>
        <legend>Saved mapping profiles</legend>
        {!view.profileEnabled ? <p className="dim">Saving and loading profiles requires a signed-in staff account on a login-enabled workspace.</p> : null}
        {view.profileEnabled && view.stages.length === 0 ? <p className="dim">Named profiles need a configured journey stage for this dataset.</p> : null}
        {view.profileEnabled && !stage ? <p className="dim">Choose a journey stage to see profiles for this dataset.</p> : null}
        {view.profileEnabled && stage?.slug ? <>
          {profiles.map((saved) => (
            <div key={saved.id} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span>{saved.profile.name}{selected?.id === saved.id ? " (selected)" : saved.matches ? " (suggested)" : " (different layout)"}</span>
              <button type="button" className="btn" disabled={busy} onClick={() => { setInspected(saved); setName(saved.profile.name); }}>Inspect</button>
              {saved.matches ? <button type="button" className="btn" disabled={busy} onClick={() => apply(saved)}>Use profile</button> : null}
            </div>
          ))}
          {inspected ? (
            <div>
              <b>{inspected.profile.name}</b> · version {inspected.revision} · {inspected.profile.rules.dateOrder.toUpperCase()} dates
              <ul>
                {Object.entries(inspected.profile.mapping).map(([field, header]) => <li key={field}>{displayField(field)}: {header}</li>)}
              </ul>
              {!inspected.matches ? <p className="dim">The file layout differs. Review the mapping above before replacing this profile.</p> : null}
            </div>
          ) : null}
          <label>Profile name{" "}<input maxLength={80} disabled={busy} value={name} onChange={(event) => setName(event.currentTarget.value)} /></label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="btn" disabled={!name.trim() || !completeManual || busy} onClick={() => void save(false)}>Save as new profile</button>
            {inspected ? <button type="button" className="btn" disabled={!name.trim() || !completeManual || busy} onClick={() => void save(true)}>Update inspected profile</button> : null}
          </div>
        </> : null}
        {profileNotice ? <p role="status">{profileNotice}</p> : null}
      </fieldset>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" className="btn primary" disabled={busy || Boolean(dateBlock) || (manual && (!completeManual || !stage))} onClick={preview}>Preview import</button>
        <button type="button" className="btn" disabled={busy} onClick={onStartOver}>Choose a different file</button>
      </div>
    </div>
  );
}
