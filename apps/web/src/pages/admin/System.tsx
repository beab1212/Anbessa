// System health (platform-service /api/platform/system): every service, outboxes, Kafka consumer
// lag, Redis and the outside services we depend on. Refreshes every 15 s.

import { Fragment } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { dayAndTime, since } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { Notice, PageHead, Pill, Problem, Stat } from "../../components/ui";

export interface SystemReport {
  checkedAt: string;
  services: { name: string; status: "up" | "degraded" | "down"; latencyMs: number | null; detail?: Record<string, unknown>; error?: string }[];
  outbox: { name: string; pending: number | null; oldestAt: string | null; error?: string }[];
  kafka: { configured: boolean; groups: { groupId: string; lag: number | null; topics: { topic: string; lag: number }[]; error?: string }[]; error?: string };
  redis: { configured: boolean; status: string; latencyMs: number | null };
  integrations: {
    messaging: { otp?: { channels: string[]; fallbackSeconds: number; telegramConfigured: boolean; telegramBalance: { usd: number; at: string } | null; lastHour: { channel: string; status: string; count: number }[]; smsFallbackRate: number | null }; failedNotifications24h?: Record<string, number>; error?: string } | null;
    routing: Record<string, string> | null;
    locationStream: { published: number; dropped: number } | null;
    documentStorage: { kind: string; ok: boolean; detail?: string; error?: string } | null;
    payments?: {
      mode?: string;
      providers?: { provider: string; label: string; methods: string[]; openCharges: number; callbacks24h: number; rejected24h: number }[];
      unprocessedCallbacks?: number;
      error?: string;
    } | null;
  };
}

const tone = (s: string) => (s === "up" ? "green" : s === "degraded" ? "amber" : "red") as "green" | "amber" | "red";

export function useSystem(enabled = true) {
  return useQuery({ queryKey: ["system"], enabled, refetchInterval: 15_000, queryFn: () => api<SystemReport>("staff", "/api/platform/system") });
}

/** The few things that need someone now. */
export function systemAlerts(r: SystemReport | undefined, now = Date.now()): string[] {
  if (!r) return [];
  const out: string[] = [];
  for (const s of r.services) if (s.status === "down") out.push(`${s.name} is down`);
  for (const o of r.outbox) if (o.oldestAt && now - new Date(o.oldestAt).getTime() > 60_000) out.push(`${o.name}: events waiting over a minute to be published`);
  for (const g of r.kafka.groups) if ((g.lag ?? 0) > 1000) out.push(`${g.groupId} is ${g.lag} events behind`);
  const otp = r.integrations.messaging?.otp;
  if (otp?.smsFallbackRate !== null && otp?.smsFallbackRate !== undefined && otp.smsFallbackRate > 0.5) out.push("over half of login codes fall back to SMS");
  if (r.integrations.documentStorage && !r.integrations.documentStorage.ok) out.push("document storage is unreachable");
  if ((r.integrations.payments?.unprocessedCallbacks ?? 0) > 0) out.push("payment provider callbacks are waiting to be processed");
  for (const p of r.integrations.payments?.providers ?? []) if (p.rejected24h > 0) out.push(`${p.label}: ${p.rejected24h} callbacks with a bad signature in 24 h`);
  return out;
}

export function SystemPage() {
  const qc = useQueryClient();
  const q = useSystem();
  const now = useNow(15_000);
  const r = q.data;
  const up = r?.services.filter((s) => s.status === "up").length ?? 0;
  const alerts = systemAlerts(r, now);
  const otp = r?.integrations.messaging?.otp;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="System"
        lede={r ? `Last checked ${dayAndTime(r.checkedAt)}. Refreshes every 15 seconds.` : "Checking every service…"}
        right={<button className="btn secondary" onClick={() => void api("staff", "/api/platform/system?refresh=true").then(() => qc.invalidateQueries({ queryKey: ["system"] }))}><RefreshCw /> Check now</button>}
      />
      <Problem error={q.error} />
      {alerts.map((a) => <Notice key={a} tone="error">{a}</Notice>)}
      {r ? (
        <>
          <div className="stats">
            <Stat label="Services up" value={`${up} / ${r.services.length}`} alert={up < r.services.length} />
            <Stat label="Events waiting" value={r.outbox.reduce((n, o) => n + (o.pending ?? 0), 0)} sub="in outboxes" />
            <Stat label="Kafka lag" value={r.kafka.configured ? r.kafka.groups.reduce((n, g) => n + (g.lag ?? 0), 0) : "—"} sub={r.kafka.configured ? "events behind" : "not configured"} />
            <Stat label="Redis" value={r.redis.status === "up" ? `${r.redis.latencyMs} ms` : "down"} alert={r.redis.status !== "up"} />
          </div>

          <section className="card">
            <div className="card-head"><h2>Services</h2></div>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead><tr><th>Service</th><th>Status</th><th className="num">Answer</th><th>Notes</th></tr></thead>
                <tbody>
                  {r.services.map((s) => (
                    <tr key={s.name}>
                      <td className="mono">{s.name}</td>
                      <td><Pill tone={tone(s.status)}>{s.status}</Pill></td>
                      <td className="num mono">{s.latencyMs === null ? "—" : `${s.latencyMs} ms`}</td>
                      <td className="xs muted">{s.error ?? (s.detail ? Object.entries(s.detail).filter(([k]) => k !== "status").map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(" · ") : "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="two-col">
            <section className="card">
              <div className="card-head"><h2>Outboxes</h2><span className="xs muted">events committed, not yet on Kafka</span></div>
              <div className="card-body">
                <dl className="kv">
                  {r.outbox.map((o) => (
                    <Fragment key={o.name}><dt>{o.name}</dt><dd>{o.error ? <span className="muted">{o.error}</span> : <><strong>{o.pending}</strong>{o.oldestAt ? <span className="xs muted"> · oldest {since(o.oldestAt, now)}</span> : null}</>}</dd></Fragment>
                  ))}
                </dl>
              </div>
            </section>
            <section className="card">
              <div className="card-head"><h2>Kafka consumers</h2></div>
              <div className="card-body">
                {!r.kafka.configured ? <p className="small muted" style={{ margin: 0 }}>KAFKA_BROKERS isn't set for platform-service.</p> : null}
                {r.kafka.error ? <Notice tone="error">{r.kafka.error}</Notice> : null}
                <dl className="kv">
                  {r.kafka.groups.map((g) => (
                    <Fragment key={g.groupId}><dt>{g.groupId}</dt><dd>{g.error ? <span className="muted">{g.error}</span> : <><strong>{g.lag}</strong> behind <span className="xs muted">{g.topics.map((t) => `${t.topic} ${t.lag}`).join(" · ")}</span></>}</dd></Fragment>
                  ))}
                </dl>
              </div>
            </section>
          </div>

          <section className="card">
            <div className="card-head"><h2>Outside services</h2></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Login codes</dt>
                <dd>
                  {otp ? (
                    <>
                      {otp.channels.join(" → ")} · SMS after {otp.fallbackSeconds} s
                      {otp.telegramConfigured ? null : <span className="muted"> · Telegram not configured</span>}
                      {otp.telegramBalance ? <span className="muted"> · Telegram balance ${otp.telegramBalance.usd.toFixed(2)}</span> : null}
                      <div className="xs muted">last hour: {otp.lastHour.length ? otp.lastHour.map((x) => `${x.channel} ${x.status.toLowerCase()} ${x.count}`).join(" · ") : "nothing sent"}{otp.smsFallbackRate !== null ? ` · ${Math.round(otp.smsFallbackRate * 100)}% fell back to SMS` : ""}</div>
                    </>
                  ) : <span className="muted">{r.integrations.messaging?.error ?? "notification-service unreachable"}</span>}
                </dd>
                <dt>Failed messages (24 h)</dt>
                <dd>{r.integrations.messaging?.failedNotifications24h ? Object.entries(r.integrations.messaging.failedNotifications24h).map(([c, n]) => `${c} ${n}`).join(" · ") || "none" : "—"}</dd>
                <dt>Routing (OSRM, Nominatim)</dt>
                <dd>{r.integrations.routing ? Object.entries(r.integrations.routing).map(([k, v]) => <span key={k} style={{ marginRight: "0.5rem" }}>{k} <Pill tone={v === "ok" ? "green" : "amber"}>{v === "ok" ? "ok" : "estimating"}</Pill></span>) : <span className="muted">mapping-service unreachable</span>}</dd>
                <dt>Document storage</dt>
                <dd>{r.integrations.documentStorage ? <>{r.integrations.documentStorage.kind ?? ""} <Pill tone={r.integrations.documentStorage.ok ? "green" : "red"}>{r.integrations.documentStorage.ok ? "ok" : "unreachable"}</Pill> <span className="xs muted">{r.integrations.documentStorage.detail ?? r.integrations.documentStorage.error}</span></> : <span className="muted">fleet-service unreachable</span>}</dd>
                <dt>Payment providers</dt>
                <dd>
                  {r.integrations.payments?.providers ? (
                    <>
                      {r.integrations.payments.mode === "simulated" ? <Pill tone="amber">simulated</Pill> : null}
                      {r.integrations.payments.providers.map((p) => (
                        <div key={p.provider} className="xs" style={{ marginTop: "0.2rem" }}>
                          <strong>{p.label}</strong> <span className="muted">{p.methods.join(", ").toLowerCase().replace("_", " ")} · {p.openCharges} waiting for the payer · {p.callbacks24h} callbacks in 24 h{p.rejected24h ? ` · ${p.rejected24h} rejected` : ""}</span>
                        </div>
                      ))}
                    </>
                  ) : <span className="muted">{r.integrations.payments?.error ?? "payment-service unreachable"}</span>}
                </dd>
                <dt>Live locations to Kafka</dt>
                <dd>{r.integrations.locationStream ? `${r.integrations.locationStream.published} published · ${r.integrations.locationStream.dropped} dropped` : <span className="muted">realtime-gateway unreachable</span>}</dd>
              </dl>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
