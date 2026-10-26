// Payment providers (payment-service /api/payments/gateways): which are connected, whether
// they're simulated, and their latest callbacks (signature checked, outcome).

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { dayAndTime } from "../../lib/format";
import { PROVIDER_LABEL, type Provider } from "../../lib/money";
import { Notice, PageHead, Pill, Problem } from "../../components/ui";

interface Gateways {
  providers: Provider[];
  simulator: { autoApproveSeconds: number; payoutSeconds: number; dropWebhooks: number } | null;
  webhooks: { last24h: { provider: string; signatureOk: boolean; count: number }[]; unprocessed: number };
  recent: { id: string; provider: string; eventKey: string; signatureOk: boolean; outcome: string | null; receivedAt: string; processedAt: string | null }[];
}

export function ProvidersPage() {
  const q = useQuery({ queryKey: ["money", "gateways"], refetchInterval: 15_000, queryFn: () => api<Gateways>("staff", "/api/payments/gateways") });
  const g = q.data;
  const count = (provider: string, ok: boolean) => g?.webhooks.last24h.find((x) => x.provider === provider && x.signatureOk === ok)?.count ?? 0;
  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Payment providers" lede="Mobile money and card providers, and every callback they sent." />
      <Problem error={q.error} />
      {g?.simulator ? (
        <Notice>
          Providers are <strong>simulated</strong>: no real money moves. Charges {g.simulator.autoApproveSeconds ? `approve themselves after ${g.simulator.autoApproveSeconds} s` : "wait for the payment page"}, payouts
          finish after {g.simulator.payoutSeconds} s (an account ending in 0000 fails){g.simulator.dropWebhooks ? `, ${Math.round(g.simulator.dropWebhooks * 100)}% of callbacks are dropped to test reconciliation` : ""}.
        </Notice>
      ) : null}
      {g?.webhooks.unprocessed ? <Notice tone="error">{g.webhooks.unprocessed} callbacks haven't been processed for over a minute.</Notice> : null}
      {g ? (
        <div className="stats">
          {g.providers.map((p) => (
            <div key={p.provider} className="stat">
              <span className="label">{p.label}</span>
              <div className="value" style={{ fontSize: "1.1rem" }}>{p.methods.map((m) => (m === "CARD" ? "cards" : "mobile money")).join(", ")}</div>
              <div className="sub">{p.mode === "simulated" ? <Pill tone="amber">simulated</Pill> : <Pill tone="green">live</Pill>} {count(p.provider, true)} callbacks today{count(p.provider, false) ? ` · ${count(p.provider, false)} rejected` : ""}</div>
            </div>
          ))}
        </div>
      ) : null}
      {g?.recent.length ? (
        <section className="card">
          <div className="card-head"><h2>Latest callbacks</h2></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Received</th><th>Provider</th><th>Notification</th><th>Signature</th><th>Outcome</th></tr></thead>
              <tbody>
                {g.recent.map((w) => (
                  <tr key={w.id}>
                    <td className="small">{dayAndTime(w.receivedAt)}</td>
                    <td className="small">{PROVIDER_LABEL[w.provider] ?? w.provider}</td>
                    <td className="mono xs">{w.eventKey}</td>
                    <td>{w.signatureOk ? <Pill tone="green">valid</Pill> : <Pill tone="red">refused</Pill>}</td>
                    <td className="small">{w.outcome ?? (w.processedAt ? "" : <span className="muted">not processed yet</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
