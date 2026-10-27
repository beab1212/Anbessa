// Fares per city and vehicle type (workflow 15 part A). Operations proposes a new fare card with a
// start time (at least 24 h ahead) and sees its impact on typical trips; another operations manager
// of the city or the finance manager approves it (maker ≠ checker). Quotes issued before keep
// their price. Until a city has an approved fare, the fares under Settings → Fares apply.

import { Fragment, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowed } from "../../lib/api";
import { birr, CITIES, CITY_NAMES, dayAndTime } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import {
  earliestValidFrom, FARE_CHANGE_LABEL, FARE_PARTS, fareChangeTone, faresApi, PRICING_VIEWERS,
  type FareCard, type FareChange, type FareOverview, type Impact,
} from "../../lib/marketing";
import { citiesWithAny, toMinor } from "../../lib/money";
import { useSession } from "../../lib/session";
import { Drawer, Empty, Field, Notice, PageHead, Pill, Problem, TextArea } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";

const cardLine = (c: FareCard) => `${birr(c.baseMinor)} + ${birr(c.perKmMinor)}/km + ${birr(c.perMinMinor)}/min, min ${birr(c.minFareMinor)}`;

export function PricingPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const name = useStaffNames();
  const cities = citiesWithAny(p, PRICING_VIEWERS, CITIES);
  const [params, setParams] = useSearchParams();
  const asked = params.get("city");
  const city = asked && cities.includes(asked) ? asked : (cities[0] ?? null);
  const [proposing, setProposing] = useState<{ vehicleType: string; current: FareCard } | null>(null);
  const [open, setOpen] = useState<FareChange | null>(null);
  const now = useNow(60_000);
  const overview = useQuery({ queryKey: ["pricing", "overview", city], enabled: !!city, queryFn: () => faresApi.overview(city!) });
  const changes = useQuery({ queryKey: ["pricing", "changes", city], enabled: !!city, queryFn: () => faresApi.changes(city!) });

  if (!city) return <div className="page"><PageHead title="Fares" /><Empty title="No city to show.">Your roles don't cover any city's fares.</Empty></div>;
  const canPropose = allowed(p, "pricing:propose", { cityId: city });
  const pending = (changes.data ?? []).filter((c) => c.status === "PENDING");
  const decided = (changes.data ?? []).filter((c) => c.status !== "PENDING");

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Fares" lede={`Operations proposes, a second person approves. New fares start at least ${overview.data?.minNoticeHours ?? 24} hours after approval; quotes already given keep their price.`} />
      {cities.length > 1 ? (
        <div className="chips">
          {cities.map((c) => <button key={c} className="chip" aria-pressed={city === c} onClick={() => setParams({ city: c })}>{CITY_NAMES[c] ?? c}</button>)}
        </div>
      ) : <p className="small muted" style={{ margin: 0 }}>{CITY_NAMES[city] ?? city}</p>}
      <Problem error={overview.error ?? changes.error} />

      <section className="card">
        <div className="card-head"><h2>Fares in force</h2><span className="xs muted">per vehicle type</span></div>
        {overview.isPending ? <div className="card-body small muted">Loading fares…</div> : null}
        {overview.data ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Vehicle</th><th>Now</th><th>Scheduled</th><th /></tr></thead>
              <tbody>
                {overview.data.fares.map((f) => (
                  <tr key={f.vehicleType}>
                    <td><strong>{f.vehicleType}</strong>{f.offered ? null : <div className="xs muted">not offered here</div>}</td>
                    <td className="small">
                      {f.current ? (
                        <>
                          <span className="mono">{cardLine(f.current)}</span>
                          <div className="xs muted">
                            waiting {birr(f.current.waitingPerMinMinor)}/min ·{" "}
                            {f.current.source === "RULE" ? `approved fare since ${dayAndTime(f.current.validFrom)}` : "from Settings → Fares (no approved fare yet)"}
                          </div>
                        </>
                      ) : <span className="muted">no fares</span>}
                    </td>
                    <td className="small">
                      {f.scheduled.length ? f.scheduled.map((r) => <div key={r.id}><Pill tone="blue">from {dayAndTime(r.validFrom)}</Pill> <span className="mono xs">{cardLine(r.card)}</span></div>) : <span className="muted">—</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {canPropose && f.current ? <button className="btn sm secondary" onClick={() => setProposing({ vehicleType: f.vehicleType, current: f.current! })}>Propose new fares</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="card-head"><h2>Waiting for approval</h2><span className="xs muted">{pending.length}</span></div>
        {pending.length === 0 ? <div className="card-body small muted">Nothing waiting.</div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Proposed</th><th>Change</th><th>Starts</th><th>Impact</th><th /></tr></thead>
              <tbody>
                {pending.map((c) => (
                  <tr key={c.id}>
                    <td className="small">{dayAndTime(c.createdAt)}<div className="xs muted">by {name(c.makerId)}</div></td>
                    <td className="small"><strong>{c.vehicleType}</strong>{c.emergency ? <> <Pill tone="red">emergency</Pill></> : null}<div className="mono xs">{cardLine(c.card)}</div><div className="xs muted">“{c.reason}”</div></td>
                    <td className="small">{c.validFrom ? dayAndTime(c.validFrom) : "on approval"}{new Date(c.expiresAt).getTime() - now < 86_400_000 ? <div className="xs muted">expires {dayAndTime(c.expiresAt)}</div> : null}</td>
                    <td className="small">{signedPct(c.impact.averageChangePct)}</td>
                    <td style={{ textAlign: "right" }}><button className="btn sm secondary" onClick={() => setOpen(c)}>Review</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {decided.length ? (
        <section className="card">
          <div className="card-head"><h2>History</h2><span className="xs muted">latest 50</span></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Proposed</th><th>Change</th><th>Status</th></tr></thead>
              <tbody>
                {decided.map((c) => (
                  <tr key={c.id} onClick={() => setOpen(c)} style={{ cursor: "pointer" }}>
                    <td className="small">{dayAndTime(c.createdAt)}</td>
                    <td className="small"><strong>{c.vehicleType}</strong> <span className="mono xs">{cardLine(c.card)}</span>{c.validFrom ? <div className="xs muted">from {dayAndTime(c.validFrom)}</div> : null}</td>
                    <td>
                      <Pill tone={fareChangeTone(c.phase)}>{FARE_CHANGE_LABEL[c.phase]}</Pill>
                      <div className="xs muted">by {name(c.makerId)}{c.checkerId ? ` · decided by ${name(c.checkerId)}` : ""}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {proposing ? <ProposeDrawer cityId={city} vehicleType={proposing.vehicleType} current={proposing.current} overview={overview.data} onClose={() => setProposing(null)} /> : null}
      {open ? <ReviewDrawer change={open} onClose={() => setOpen(null)} name={name} /> : null}
    </div>
  );
}

const signedPct = (v: number) => `${v > 0 ? "+" : ""}${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

function ImpactTable({ impact }: { impact: Impact }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Typical trip</th><th>Now</th><th>New</th><th>Change</th></tr></thead>
        <tbody>
          {impact.samples.map((s) => (
            <tr key={s.label}>
              <td className="small">{s.label}</td>
              <td className="mono small">{birr(s.beforeMinor)}</td>
              <td className="mono small">{birr(s.afterMinor)}</td>
              <td className="small">{s.deltaMinor >= 0 ? "+" : "−"}{birr(Math.abs(s.deltaMinor))} ({signedPct(s.deltaPct)})</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="xs muted" style={{ margin: "0.5rem 0 0" }}>Average change {signedPct(impact.averageChangePct)}. Drivers' earnings follow the fare.</p>
    </div>
  );
}

function ProposeDrawer({ cityId, vehicleType, current, overview, onClose }: { cityId: string; vehicleType: string; current: FareCard; overview?: FareOverview; onClose: () => void }) {
  const qc = useQueryClient();
  const b = (m: number) => String(m / 100);
  const [values, setValues] = useState<Record<keyof FareCard, string>>({
    baseMinor: b(current.baseMinor), perKmMinor: b(current.perKmMinor), perMinMinor: b(current.perMinMinor), minFareMinor: b(current.minFareMinor), waitingPerMinMinor: b(current.waitingPerMinMinor),
  });
  const [emergency, setEmergency] = useState(false);
  const [validFrom, setValidFrom] = useState(() => earliestValidFrom(overview?.minNoticeHours ?? 24));
  const [reason, setReason] = useState("");
  const card = Object.fromEntries(FARE_PARTS.map(([k]) => [k, toMinor(values[k])])) as Record<keyof FareCard, number | null>;
  const complete = FARE_PARTS.every(([k]) => card[k] !== null);
  const preview = useMutation({ mutationFn: () => faresApi.preview(cityId, vehicleType, card as FareCard) });
  const propose = useMutation({
    mutationFn: () => faresApi.propose({ cityId, vehicleType, card: card as FareCard, emergency, reason: reason.trim(), validFrom: emergency ? null : new Date(validFrom).toISOString() }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["pricing"] }),
  });

  return (
    <Drawer title={`New ${vehicleType} fares, ${CITY_NAMES[cityId] ?? cityId}`} onClose={onClose} wide>
      {propose.isSuccess ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <Notice tone="ok">Proposed. Another operations manager of the city or the finance manager approves it here.</Notice>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <p className="small muted" style={{ margin: 0 }}>Now: <span className="mono">{cardLine(current)}</span></p>
          <div className="two-col">
            {FARE_PARTS.map(([k, label]) => (
              <Field key={k} label={`${label} (birr)`} inputMode="decimal" value={values[k]} onChange={(e) => { setValues({ ...values, [k]: e.target.value }); preview.reset(); }} />
            ))}
          </div>
          <label className="row small" style={{ gap: "0.4rem" }}>
            <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} />
            Emergency fix: takes effect as soon as it's approved
          </label>
          {emergency ? <Notice tone="error">Only to correct a wrong fare. It still needs a second person.</Notice> : (
            <Field label="Starts" type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} hint={`At least ${overview?.minNoticeHours ?? 24} hours after it's approved.`} />
          )}
          <TextArea label="Why" value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} placeholder="Fuel price up 8% since July" />
          <div className="row" style={{ gap: "0.5rem" }}>
            <button className="btn secondary" disabled={!complete || preview.isPending} onClick={() => preview.mutate()}>Preview impact</button>
          </div>
          {preview.data ? <ImpactTable impact={preview.data.impact} /> : null}
          <Problem error={preview.error ?? propose.error} />
          <div className="row" style={{ gap: "0.5rem" }}>
            <button className="btn" disabled={!complete || !reason.trim() || (!emergency && !validFrom) || propose.isPending} onClick={() => propose.mutate()}>{propose.isPending ? "Sending…" : "Propose"}</button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function ReviewDrawer({ change, onClose, name }: { change: FareChange; onClose: () => void; name: (id: string | null | undefined) => string }) {
  const { staff } = useSession();
  const p = staff.principal;
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["pricing"] });
    onClose();
  };
  const approve = useMutation({ mutationFn: () => faresApi.approve(change.id, note.trim() || undefined), onSuccess: done });
  const reject = useMutation({ mutationFn: () => faresApi.reject(change.id, note.trim()), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => faresApi.cancel(change.id), onSuccess: done });
  const mine = p?.userId === change.makerId;
  const canDecide = change.status === "PENDING" && !mine && allowed(p, "pricing:approve", { cityId: change.cityId });
  const busy = approve.isPending || reject.isPending || cancel.isPending;

  return (
    <Drawer title={`${change.vehicleType} fares, ${CITY_NAMES[change.cityId] ?? change.cityId}`} onClose={onClose} wide>
      <div className="stack" style={{ gap: "0.75rem" }}>
        <div className="row" style={{ gap: "0.5rem" }}><Pill tone={fareChangeTone(change.phase)}>{FARE_CHANGE_LABEL[change.phase]}</Pill>{change.emergency ? <Pill tone="red">emergency</Pill> : null}</div>
        <dl className="kv">
          <dt>Proposed by</dt><dd>{name(change.makerId)} · {dayAndTime(change.createdAt)}</dd>
          <dt>Why</dt><dd>{change.reason}</dd>
          <dt>Starts</dt><dd>{change.validFrom ? dayAndTime(change.validFrom) : "when approved"}</dd>
          {FARE_PARTS.map(([k, label]) => (
            <Fragment key={k}><dt>{label}</dt><dd className="mono">{birr(change.impact.current[k])} → <strong>{birr(change.card[k])}</strong></dd></Fragment>
          ))}
          {change.checkerId ? <><dt>Decided by</dt><dd>{name(change.checkerId)}{change.decidedAt ? ` · ${dayAndTime(change.decidedAt)}` : ""}{change.decisionReason ? ` · “${change.decisionReason}”` : ""}</dd></> : null}
        </dl>
        <ImpactTable impact={change.impact} />
        {change.status === "PENDING" ? (
          <>
            {mine ? <Notice>You proposed this; someone else has to approve it.</Notice> : null}
            {canDecide ? <TextArea label="Note (needed to reject)" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} /> : null}
            <Problem error={approve.error ?? reject.error ?? cancel.error} />
            <div className="row" style={{ gap: "0.5rem" }}>
              {canDecide ? <button className="btn" disabled={busy} onClick={() => approve.mutate()}>Approve</button> : null}
              {canDecide ? <button className="btn danger" disabled={busy || !note.trim()} onClick={() => reject.mutate()}>Reject</button> : null}
              {mine ? <button className="btn secondary" disabled={busy} onClick={() => cancel.mutate()}>Withdraw</button> : null}
            </div>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
