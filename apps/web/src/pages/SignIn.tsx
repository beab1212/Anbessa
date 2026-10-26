import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Building2, ShieldCheck } from "lucide-react";
import { authCall } from "../lib/api";
import { phone as fmtPhone, toE164 } from "../lib/format";
import { useSession } from "../lib/session";
import { CityMap } from "../components/map/CityMap";
import { Brand, Field, Problem } from "../components/ui";

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="signin">
      <div className="backdrop" aria-hidden="true">
        <CityMap cityId="addis-ababa" interactive={false} />
      </div>
      <div className="card pad">
        <Brand subtitle="Operations console" />
        {children}
      </div>
    </div>
  );
}

/** /sign-in — who are you? */
export function SignInChooser() {
  return (
    <Frame>
      <h1 style={{ marginBottom: "0.25rem" }}>Sign in</h1>
      <p className="muted" style={{ marginBottom: "1.25rem" }}>Choose how you work with Anbessa.</p>
      <ul className="choose">
        <li>
          <Link to="/sign-in/staff">
            <ShieldCheck />
            <span><strong>Anbessa staff</strong><span>Dispatch, call center, onboarding, safety, finance</span></span>
          </Link>
        </li>
        <li>
          <Link to="/sign-in/partner">
            <Building2 />
            <span><strong>Fleet or company</strong><span>Your registered phone number and a 6-digit code</span></span>
          </Link>
        </li>
      </ul>
    </Frame>
  );
}

/** Staff: email + password, then the authenticator code (Auth.md §9.2). */
export function StaffSignIn() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [stage, setStage] = useState<"password" | "totp">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function done() {
    await refresh("staff");
    navigate("/staff");
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await authCall<{ twoFactorRedirect?: boolean }>("staff", "/sign-in/email", { email: email.trim(), password });
      if (r.twoFactorRedirect) setStage("totp");
      else await done(); // no 2FA yet: the setup page takes over
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authCall("staff", "/two-factor/verify-totp", { code: code.trim() });
      await done();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <p className="xs muted" style={{ marginBottom: "0.5rem" }}><Link to="/sign-in">Sign in</Link> / staff</p>
      {stage === "password" ? (
        <form onSubmit={submitPassword}>
          <h1 style={{ marginBottom: "1rem" }}>Staff sign-in</h1>
          <Problem error={error} />
          <Field label="Work email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn block lg" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
          <p className="xs muted" style={{ marginTop: "1rem" }}>Staff accounts are created by a super admin. There is no sign-up.</p>
        </form>
      ) : (
        <form onSubmit={submitCode}>
          <h1 style={{ marginBottom: "0.25rem" }}>Authenticator code</h1>
          <p className="muted small" style={{ marginBottom: "1rem" }}>The 6 digits in your authenticator app for Anbessa.</p>
          <Problem error={error} />
          <Field className="code" label="Code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <button className="btn block lg" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</button>
        </form>
      )}
    </Frame>
  );
}

/** Partners: phone number + 6-digit code, delivered by Telegram or SMS (Auth.md §9.7). */
export function PartnerSignIn() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [stage, setStage] = useState<"phone" | "code">("phone");
  const [raw, setRaw] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const e164 = toE164(raw);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!e164) return;
    setBusy(true);
    setError(null);
    try {
      await authCall("partner", "/phone-number/send-otp", { phoneNumber: e164 });
      setStage("code");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authCall("partner", "/phone-number/verify", { phoneNumber: e164, code: code.trim() });
      await refresh("partner");
      navigate("/partner");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <p className="xs muted" style={{ marginBottom: "0.5rem" }}><Link to="/sign-in">Sign in</Link> / fleet or company</p>
      {stage === "phone" ? (
        <form onSubmit={send}>
          <h1 style={{ marginBottom: "1rem" }}>Your phone number</h1>
          <Problem error={error} />
          <Field className="big" label="Mobile number" inputMode="tel" autoComplete="tel" placeholder="09 11 22 33 44" required value={raw} onChange={(e) => setRaw(e.target.value)} hint={e164 ? `We'll send a code to ${fmtPhone(e164)}` : "An Ethiopian mobile number, starting 09 or 07"} />
          <button className="btn block lg" disabled={busy || !e164}>{busy ? "Sending…" : "Send code"}</button>
          <p className="xs muted" style={{ marginTop: "1rem" }}>New here? Sign in first, then register your company. Our onboarding team checks the TIN before you can add drivers or book on the account.</p>
        </form>
      ) : (
        <form onSubmit={verify}>
          <h1 style={{ marginBottom: "0.25rem" }}>Enter the code</h1>
          <p className="muted small" style={{ marginBottom: "1rem" }}>Sent to {fmtPhone(e164)}. Check Telegram first (Verification Codes chat); after 20 seconds it also comes by SMS.</p>
          <Problem error={error} />
          <Field className="code" label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <button className="btn block lg" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</button>
          <div className="row" style={{ marginTop: "0.75rem", gap: "1rem" }}>
            <button type="button" className="link" onClick={() => void send()}>Send a new code</button>
            <button type="button" className="link quiet" onClick={() => setStage("phone")}>Different number</button>
          </div>
        </form>
      )}
    </Frame>
  );
}
