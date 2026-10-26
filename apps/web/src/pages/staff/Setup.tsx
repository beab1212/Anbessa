import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import { authCall } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Brand, Field, Problem } from "../../components/ui";

/**
 * First sign-in of a staff account (Auth.md §17, I3): roles stay off until the temporary
 * password is replaced and an authenticator app is enrolled.
 */
export function StaffSetup() {
  const navigate = useNavigate();
  const { staff, refresh } = useSession();
  const setup = staff.claims?.setup;
  const needsPassword = !!setup?.changePassword;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [password, setPassword] = useState(""); // to enable 2FA
  const [enrol, setEnrol] = useState<{ uri: string; qr: string; secret: string; backup: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!staff.loading && staff.claims && !staff.claims.setup) navigate("/staff", { replace: true });
  }, [staff, navigate]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await authCall("staff", "/change-password", { currentPassword: current, newPassword: next, revokeOtherSessions: true });
      setPassword(next);
      await refresh("staff");
    });
  };

  const startEnrol = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await authCall<{ totpURI: string; backupCodes: string[] }>("staff", "/two-factor/enable", { password });
      const secret = new URL(r.totpURI).searchParams.get("secret") ?? "";
      const qr = await QRCode.toDataURL(r.totpURI, { margin: 1, width: 200, color: { dark: "#0f172a", light: "#ffffff" } });
      setEnrol({ uri: r.totpURI, qr, secret, backup: r.backupCodes });
    });
  };

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await authCall("staff", "/two-factor/verify-totp", { code });
      await refresh("staff");
      navigate("/staff", { replace: true });
    });
  };

  return (
    <div className="signin" style={{ alignItems: "start", paddingTop: "4rem" }}>
      <div className="card pad" style={{ width: "min(40rem, 100%)", position: "relative", zIndex: 1, boxShadow: "var(--shadow)" }}>
        <Brand subtitle="Account setup" />
        <h1 style={{ marginBottom: "0.25rem" }}>Before your roles switch on</h1>
        <p className="muted" style={{ marginBottom: "1.25rem" }}>Two things, once.</p>
        <div className="steps">
          <span className={needsPassword ? "now" : "done"}>Replace the temporary password</span>
          <span className={needsPassword ? "" : "now"}>Add an authenticator app</span>
        </div>
        <Problem error={error} />

        {needsPassword ? (
          <form onSubmit={changePassword}>
            <Field label="Temporary password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
            <Field label="New password" type="password" autoComplete="new-password" minLength={12} required value={next} onChange={(e) => setNext(e.target.value)} hint="At least 12 characters. A sentence works well." />
            <button className="btn" disabled={busy}>Save password</button>
          </form>
        ) : !enrol ? (
          <form onSubmit={startEnrol}>
            <p className="small muted">Google Authenticator, Microsoft Authenticator, 1Password, Aegis: any TOTP app works.</p>
            <Field label="Your password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="btn" disabled={busy}>Show the QR code</button>
          </form>
        ) : (
          <div className="two-col">
            <div>
              <img src={enrol.qr} alt="QR code for your authenticator app" width={200} height={200} style={{ border: "1px solid var(--border)", borderRadius: "var(--r)", display: "block" }} />
              <p className="xs muted" style={{ marginTop: "0.5rem" }}>Or type this key: <span className="mono">{enrol.secret.match(/.{1,4}/g)?.join(" ")}</span></p>
            </div>
            <div>
              <form onSubmit={confirm}>
                <Field className="code" label="Code from the app" inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                <button className="btn" disabled={busy || code.length !== 6}>Confirm</button>
              </form>
              <div className="handover" style={{ marginTop: "1rem" }}>
                <span className="label">Backup codes: each works once. Save them now; they aren't shown again.</span>
                <ul className="mono small" style={{ columns: 2, listStyle: "none", padding: 0, margin: "0.5rem 0 0", lineHeight: 1.9 }}>{enrol.backup.map((b) => <li key={b}>{b}</li>)}</ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
