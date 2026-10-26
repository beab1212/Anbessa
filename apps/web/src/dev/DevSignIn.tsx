// Development only. SignIn.tsx loads this behind `import.meta.env.DEV`, so production builds
// don't contain it, and auth-service only serves /api/dev/* with DEV_LOGIN=on (refused in
// production). It signs in through the normal endpoints, asking /api/dev/code for the code a
// person would read from their authenticator app or SMS.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LogIn } from "lucide-react";
import { ApiError, authCall, http, type Surface } from "../lib/api";
import { phone as fmtPhone } from "../lib/format";
import { useSession } from "../lib/session";
import { Pill, Problem } from "../components/ui";
import "./dev.css";

interface DevAccount {
  key: string;
  surface: Surface;
  name: string;
  label: string;
  email?: string;
  password?: string;
  phone?: string;
  seeded: boolean;
}

const devGet = <T,>(path: string) => http.get<T>(`/api/dev${path}`).then((r) => r.data);

const devCode = (q: Record<string, string>) => devGet<{ code: string }>(`/code?${new URLSearchParams(q)}`).then((r) => r.code);

export default function DevSignIn({ initial = "staff" }: { initial?: Surface }) {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [tab, setTab] = useState<Surface>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const accounts = useQuery({ queryKey: ["dev-accounts"], retry: false, queryFn: () => devGet<{ accounts: DevAccount[] }>("/accounts").then((r) => r.accounts) });

  async function signIn(a: DevAccount) {
    setBusy(a.key);
    setError(null);
    try {
      if (a.surface === "staff") {
        const r = await authCall<{ twoFactorRedirect?: boolean }>("staff", "/sign-in/email", { email: a.email, password: a.password });
        if (r.twoFactorRedirect) await authCall("staff", "/two-factor/verify-totp", { code: await devCode({ email: a.email! }) });
        await refresh("staff");
        navigate("/staff");
      } else {
        // the console OTP lands in auth-service's dev inbox before send-otp responds
        await authCall("partner", "/phone-number/send-otp", { phoneNumber: a.phone });
        await authCall("partner", "/phone-number/verify", { phoneNumber: a.phone, code: await devCode({ phone: a.phone! }) });
        await refresh("partner");
        navigate("/partner");
      }
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? new ApiError(429, "rate", "Rate limited. Wait a minute, or set AUTH_RATE_LIMIT=off in auth-service's .env") : err);
    } finally {
      setBusy(null);
    }
  }

  const list = (accounts.data ?? []).filter((a) => a.surface === tab);
  const unseeded = (accounts.data ?? []).some((a) => !a.seeded);

  return (
    <section className="card pad dev-signin" aria-label="Development sign-in">
      <div className="row between" style={{ marginBottom: "0.6rem" }}>
        <strong>Sign in as…</strong>
        <Pill tone="amber">development only</Pill>
      </div>

      {accounts.isError ? (
        <p className="small muted" style={{ margin: 0 }}>
          Dev sign-in is off. In <span className="mono">services/auth-service/.env</span> set <span className="mono">DEV_LOGIN=on</span>, restart it, and run{" "}
          <span className="mono">pnpm --filter @ride-app/auth-service seed:dev</span>.
        </p>
      ) : (
        <>
          <div className="tabs" role="tablist" style={{ marginBottom: "0.6rem" }}>
            {(["staff", "partner"] as const).map((s) => (
              <button key={s} role="tab" aria-selected={tab === s} onClick={() => setTab(s)}>{s === "staff" ? "Staff" : "Fleet and companies"}</button>
            ))}
          </div>
          <Problem error={error} />
          {unseeded ? <p className="xs muted" style={{ margin: "0 0 0.5rem" }}>Some accounts don't exist yet: run <span className="mono">pnpm --filter @ride-app/auth-service seed:dev</span>.</p> : null}
          <ul className="dev-accounts">
            {list.map((a) => (
              <li key={a.key}>
                <button type="button" disabled={!a.seeded || busy !== null} onClick={() => void signIn(a)}>
                  <span>
                    <strong>{a.label}</strong>
                    <span className="muted">{a.name} · <span className="mono">{a.email ?? fmtPhone(a.phone)}</span></span>
                  </span>
                  {busy === a.key ? <span className="xs muted">signing in…</span> : <LogIn />}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
