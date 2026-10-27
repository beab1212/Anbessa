// Zones per city (workflow 15 part B): service areas, no-pickup areas, airport fees and surge.
// Operations draws a polygon on the map (click to add points), checks it, saves it. pricing-service
// validates the outline (inside the city, not crossing itself) and applies it to new quotes at once.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as maplibregl from "maplibre-gl";
import type { LatLng } from "@ride-app/shared-location";
import { citiesFor } from "../../lib/api";
import { birr, CITIES, CITY_NAMES, dayAndTime } from "../../lib/format";
import { fromRing, toRing, ZONE_COLOR, ZONE_HINT, ZONE_KINDS, ZONE_LABEL, zonesApi, type Zone, type ZoneInput, type ZoneKind } from "../../lib/marketing";
import { toMinor } from "../../lib/money";
import { useSession } from "../../lib/session";
import { CityMap, useMap } from "../../components/map/CityMap";
import { PickupMarker } from "../../components/map/markers";
import { Empty, Field, Notice, PageHead, Pill, Problem, SelectField } from "../../components/ui";

interface Draft {
  id: string | null;
  version: number;
  name: string;
  kind: ZoneKind;
  points: LatLng[];
  fee: string;
  surge: string;
}

const blank = (): Draft => ({ id: null, version: 0, name: "", kind: "NO_PICKUP", points: [], fee: "50", surge: "1.3" });

export function ZonesPage() {
  const { staff } = useSession();
  const cities = citiesFor(staff.principal, "zone:manage", CITIES);
  const [params, setParams] = useSearchParams();
  const asked = params.get("city");
  const cityId = asked && cities.includes(asked) ? asked : (cities[0] ?? null);
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["zones", cityId, showArchived], enabled: !!cityId, queryFn: () => zonesApi.list(cityId!, showArchived) });
  const zones = useMemo(() => q.data ?? [], [q.data]);
  const live = zones.filter((z) => !z.archivedAt);

  const archive = useMutation({
    mutationFn: (id: string) => zonesApi.archive(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["zones"] }),
  });

  if (!cityId) return <div className="page"><PageHead title="Zones" /><Empty title="No city to show.">Your roles don't include zone:manage in any city.</Empty></div>;

  const edit = (z: Zone) => {
    setSelected(z.id);
    setDraft({ id: z.id, version: z.version, name: z.name, kind: z.kind, points: fromRing(z.polygon), fee: String(z.feeMinor / 100), surge: String(z.surgeMultiplier) });
  };
  const fitTo = draft?.points.length ? draft.points : selected ? fromRing(zones.find((z) => z.id === selected)?.polygon ?? []) : [];

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Zones"
        lede="Polygons pricing applies to every new quote: where pickups are allowed, airport fees and surge. Changes take effect at once and are audited."
        right={draft ? null : <button className="btn" onClick={() => { setSelected(null); setDraft(blank()); }}>Draw a zone</button>}
      />
      {cities.length > 1 ? (
        <div className="chips">
          {cities.map((c) => <button key={c} className="chip" aria-pressed={cityId === c} onClick={() => { setParams({ city: c }); setDraft(null); setSelected(null); }}>{CITY_NAMES[c] ?? c}</button>)}
        </div>
      ) : <p className="small muted" style={{ margin: 0 }}>{CITY_NAMES[cityId] ?? cityId}</p>}
      <Problem error={q.error ?? archive.error} />

      <div className="two-col wide-left">
        <div style={{ height: "70vh", minHeight: 420 }}>
          <CityMap
            cityId={cityId} boxed fit={fitTo} fitOnce={!!draft}
            onClick={draft ? (p) => setDraft((d) => (d ? { ...d, points: [...d.points, p] } : d)) : undefined}
          >
            <ZoneLayer zones={live.filter((z) => z.id !== draft?.id)} selected={selected} />
            {draft ? <DraftLayer points={draft.points} kind={draft.kind} /> : null}
            {draft?.points.map((p, i) => <PickupMarker key={`${i}-${p.lat}-${p.lng}`} lat={p.lat} lng={p.lng} tone="grey" label={String(i + 1)} title={`Point ${i + 1}`} />)}
          </CityMap>
        </div>
        <div className="stack" style={{ gap: "1rem" }}>
          {draft ? (
            <ZoneEditor
              key={draft.id ?? "new"} cityId={cityId} draft={draft} onChange={setDraft}
              onDone={() => { setDraft(null); void qc.invalidateQueries({ queryKey: ["zones"] }); }}
            />
          ) : null}
          <section className="card">
            <div className="card-head">
              <h2>{CITY_NAMES[cityId] ?? cityId}</h2>
              <label className="xs muted row" style={{ gap: "0.35rem" }}>
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived too
              </label>
            </div>
            {q.isPending ? <div className="card-body small muted">Loading zones…</div> : null}
            {!q.isPending && zones.length === 0 ? <div className="card-body"><Empty title="No zones yet.">Pickups are allowed anywhere in the city and no fees or surge apply.</Empty></div> : null}
            {zones.length ? (
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {zones.map((z) => (
                      <tr key={z.id} aria-selected={selected === z.id} onClick={() => setSelected(z.id)} style={{ cursor: "pointer", opacity: z.archivedAt ? 0.55 : 1 }}>
                        <td>
                          <strong>{z.name}</strong>
                          <div className="xs muted">v{z.version} · updated {dayAndTime(z.updatedAt)}{z.archivedAt ? ` · archived ${dayAndTime(z.archivedAt)}` : ""}</div>
                        </td>
                        <td>
                          <Pill tone={z.kind === "NO_PICKUP" ? "red" : z.kind === "SERVICE_AREA" ? "green" : z.kind === "AIRPORT" ? "blue" : "amber"}>{ZONE_LABEL[z.kind]}</Pill>
                          <div className="xs muted">{z.kind === "AIRPORT" ? birr(z.feeMinor) : z.kind === "SURGE" ? `× ${z.surgeMultiplier}` : ""}</div>
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          {!z.archivedAt && !draft ? (
                            <>
                              <button className="btn sm secondary" onClick={(e) => { e.stopPropagation(); edit(z); }}>Edit</button>{" "}
                              <button
                                className="btn sm ghost" disabled={archive.isPending}
                                onClick={(e) => { e.stopPropagation(); if (window.confirm(`Archive "${z.name}"? New quotes stop using it.`)) archive.mutate(z.id); }}
                              >Archive</button>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
          <section className="card">
            <div className="card-body small">
              {ZONE_KINDS.map((k) => <p key={k} style={{ margin: "0 0 0.4rem" }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: ZONE_COLOR[k], marginRight: 6 }} /><strong>{ZONE_LABEL[k]}</strong>: <span className="muted">{ZONE_HINT[k]}</span></p>)}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ZoneEditor({ cityId, draft, onChange, onDone }: { cityId: string; draft: Draft; onChange: (d: Draft | null) => void; onDone: () => void }) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const input = (): ZoneInput => ({
    name: draft.name.trim(), kind: draft.kind, polygon: toRing(draft.points),
    ...(draft.kind === "AIRPORT" ? { feeMinor: toMinor(draft.fee) ?? 0 } : {}),
    ...(draft.kind === "SURGE" ? { surgeMultiplier: Number(draft.surge) } : {}),
  });
  const check = useMutation({ mutationFn: () => zonesApi.check(cityId, toRing(draft.points)) });
  const save = useMutation({
    mutationFn: () => (draft.id ? zonesApi.update(draft.id, draft.version, input()) : zonesApi.create(cityId, input())),
    onSuccess: onDone,
  });
  useEffect(() => check.reset(), [draft.points.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const surge = Number(draft.surge);
  const valid = draft.name.trim().length > 0 && draft.points.length >= 3
    && (draft.kind !== "AIRPORT" || (toMinor(draft.fee) ?? 0) > 0)
    && (draft.kind !== "SURGE" || (surge > 1 && surge <= 3));

  return (
    <section className="card">
      <div className="card-head"><h2>{draft.id ? "Edit zone" : "New zone"}</h2><span className="xs muted">{draft.points.length} points</span></div>
      <div className="card-body stack" style={{ gap: "0.75rem" }}>
        <Notice>Click the map to add points in order around the area. At least 3; the outline must not cross itself.</Notice>
        <Field label="Name" value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Bole airport" />
        <SelectField label="Kind" value={draft.kind} onChange={(e) => set({ kind: e.target.value as ZoneKind })}>
          {ZONE_KINDS.map((k) => <option key={k} value={k}>{ZONE_LABEL[k]}</option>)}
        </SelectField>
        <p className="xs muted" style={{ margin: 0 }}>{ZONE_HINT[draft.kind]}</p>
        {draft.kind === "AIRPORT" ? <Field label="Fee (birr)" inputMode="decimal" value={draft.fee} onChange={(e) => set({ fee: e.target.value })} /> : null}
        {draft.kind === "SURGE" ? <Field label="Multiplier" inputMode="decimal" value={draft.surge} onChange={(e) => set({ surge: e.target.value })} hint="Above 1, at most 3 (1.5 = fares 50% higher)" /> : null}
        <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
          <button className="btn sm secondary" disabled={!draft.points.length} onClick={() => set({ points: draft.points.slice(0, -1) })}>Undo point</button>
          <button className="btn sm ghost" disabled={!draft.points.length} onClick={() => set({ points: [] })}>Clear</button>
          <button className="btn sm secondary" disabled={draft.points.length < 3 || check.isPending} onClick={() => check.mutate()}>Check outline</button>
        </div>
        {check.data ? (check.data.valid ? <Notice tone="ok">The outline is valid ({check.data.points} points).</Notice> : <Notice tone="error">{check.data.message}</Notice>) : null}
        <Problem error={check.error ?? save.error} />
        <div className="row" style={{ gap: "0.5rem" }}>
          <button className="btn" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : draft.id ? "Save changes" : "Save zone"}</button>
          <button className="btn ghost" onClick={() => onChange(null)}>Cancel</button>
        </div>
      </div>
    </section>
  );
}

type GeoData = Parameters<maplibregl.GeoJSONSource["setData"]>[0];

/** Adds (or updates) a GeoJSON source with a fill and an outline; removes them on unmount. */
function usePolygonLayer(id: string, data: GeoData, fill: unknown, line: unknown, dashed = false) {
  const map = useMap();
  const key = JSON.stringify(data);
  useEffect(() => {
    if (!map) return;
    const add = () => {
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
        return;
      }
      map.addSource(id, { type: "geojson", data });
      map.addLayer({ id: `${id}-fill`, type: "fill", source: id, paint: { "fill-color": fill as string, "fill-opacity": 0.18 } });
      map.addLayer({ id: `${id}-line`, type: "line", source: id, paint: { "line-color": line as string, "line-width": 2, ...(dashed ? { "line-dasharray": [2, 1] } : {}) } });
    };
    if (map.isStyleLoaded()) add();
    else map.once("load", add);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, id, key]);
  useEffect(() => () => {
    if (!map) return;
    for (const l of [`${id}-fill`, `${id}-line`]) if (map.getLayer(l)) map.removeLayer(l);
    if (map.getSource(id)) map.removeSource(id);
  }, [map, id]);
}

const kindColor = ["match", ["get", "kind"], ...ZONE_KINDS.flatMap((k) => [k, ZONE_COLOR[k]]), "#64748b"];

function ZoneLayer({ zones, selected }: { zones: Zone[]; selected: string | null }) {
  const data: GeoData = {
    type: "FeatureCollection",
    features: zones.map((z) => ({ type: "Feature", properties: { id: z.id, kind: z.kind, selected: z.id === selected }, geometry: { type: "Polygon", coordinates: [z.polygon] } })),
  };
  usePolygonLayer("zones", data, kindColor, kindColor);
  return null;
}

function DraftLayer({ points, kind }: { points: LatLng[]; kind: ZoneKind }) {
  const ring = toRing(points);
  const data: GeoData = points.length >= 3
    ? { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]!]] } }
    : { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ring } };
  usePolygonLayer(`zone-draft-${kind}`, data, ZONE_COLOR[kind], ZONE_COLOR[kind], true);
  return null;
}
