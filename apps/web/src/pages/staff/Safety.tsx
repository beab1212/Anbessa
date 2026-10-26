import { useState } from "react";
import { api } from "../../lib/api";
import { CITY_NAMES } from "../../lib/format";
import { useStaffCity } from "../../lib/hooks";
import { Field, Notice, PageHead, Problem, SelectField } from "../../components/ui";

/**
 * Suspension (Auth.md §9.5). Takes effect at once: every session is ended and every service
 * refuses the user's tokens. Staff accounts are suspended by super admins only.
 */
export function Safety() {
  const { cities, cityId, setCityId } = useStaffCity("user:suspend");
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const valid = /^[0-9a-f-]{36}$/i.test(userId.trim()) && reason.trim().length >= 10 && !!cityId;

  async function go(kind: "suspend" | "reinstate") {
    if (kind === "suspend" && !confirm("Suspend now? Their app and any open trip screens stop working immediately.")) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api("staff", `/api/identity/users/${userId.trim()}/${kind}`, { body: { reason: reason.trim(), cityId } });
      setDone(kind === "suspend" ? "Suspended. Their sessions are closed and their tokens refused." : "Reinstated. They can sign in again.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHead title="Suspend" lede="Use this after an incident, a confirmed fraud case or a police request. The reason goes into the audit log with your name." />
      <div className="card" style={{ maxWidth: "34rem" }}>
        <div className="card-body">
        <Problem error={error} />
        {done ? <Notice tone="ok">{done}</Notice> : null}
        <Field label="User id" className="mono" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="from the trip or the ticket" />
        {cities.length > 1 ? (
          <SelectField label="City handling the case" value={cityId ?? ""} onChange={(e) => setCityId(e.target.value)}>
            {cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </SelectField>
        ) : null}
        <div className="field">
          <label className="label" htmlFor="reason">Reason</label>
          <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What happened, and the ticket or incident number" />
          <span className="hint">{reason.trim().length < 10 ? `${10 - reason.trim().length} more characters` : "OK"}</span>
        </div>
        <div className="row">
          <button className="btn danger" disabled={busy || !valid} onClick={() => void go("suspend")}>Suspend</button>
          <button className="btn secondary" disabled={busy || !valid} onClick={() => void go("reinstate")}>Reinstate</button>
        </div>
        <p className="muted xs" style={{ marginTop: "0.9rem" }}>The city is where the case is handled. It must be one of yours.</p>
        </div>
      </div>
    </div>
  );
}
