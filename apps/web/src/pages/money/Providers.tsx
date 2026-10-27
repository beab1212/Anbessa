// Payment providers (payment-service /api/payments/gateways): which are connected, whether
// they're simulated, and their latest callbacks (signature checked, outcome). With the
// platform-wide money view, also what each provider holds for us (/api/payments/overview).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api } from "../../lib/api";
import { download } from "../../lib/admin";
import { birr, dayAndTime } from "../../lib/format";
import { csvName, everywhere, PROVIDER_LABEL, toCsv, type CsvColumn, type Provider } from "../../lib/money";
import { useSession } from "../../lib/session";
import { Empty, Notice, PageHead, Pill, Problem } from "../../components/ui";
import type { Overview } from "./Overview";

interface Callback { id: string; provider: string; eventKey: string; signatureOk: boolean; outcome: string | null; receivedAt: string; processedAt: string | null }
interface Gateways {
  providers: Provider[];
  simulator: { autoApproveSeconds: number; payoutSeconds: number; dropWebhooks: number } | null;
  webhooks: { last24h: { provider: string; signatureOk: boolean; count: number }[]; unprocessed: number };
  recent: Callback[];
}

const CALLBACK_CSV: CsvColumn<Callback>[] = [
  ["received_at", (w) => w.receivedAt], ["provider", (w) => w.provider], ["event_key", (w) => w.eventKey], ["signature_ok", (w) => w.signatureOk],
  ["outcome", (w) => w.outcome], ["processed_at", (w) => w.processedAt],
];

/** How long a callback took to process, in words ("0.4 s", "2 min"). */
function took(w: Callback): string {
  if (!w.processedAt) return "";
  const ms = new Date(w.processedAt).getTime() - new Date(w.receivedAt).getTime();
  if (ms < 1000) return `${Math.max(0, ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function ProvidersPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const [provider, setProvider] = useState("");
  const [only, setOnly] = useState<"" | "refused" | "unprocessed">("");
  const q = useQuery({ queryKey: ["money", "gateways"], refetchInterval: 15_000, queryFn: () => api<Gateways>("staff", "/api/payments/gateways") });
  const overview = useQuery({
    queryKey: ["money", "overview"], enabled: everywhere(p, "balance:read") || everywhere(p, "report:read_finance"),
    refetchInterval: 30_000, queryFn: () => api<Overview>("staff", "/api/payments/overview"),
  });
  const g = q.data;
  const count = (prov: string, ok: boolean) => g?.webhooks.last24h.find((x) => x.provider === prov && x.signatureOk === ok)?.count ?? 0;
  const lastAt = (prov: string) => g?.recent.find((w) => w.provider === prov)?.receivedAt;
  const holds = (prov: string) => overview.data?.providers.find((x) => x.provider === prov)?.balanceMinor;
  const recent = (g?.recent ?? []).filter((w) => (!provider || w.provider === provider) && (only === "refused" ? !w.signatureOk : only === "unprocessed" ? w.signatureOk && !w.processedAt : true));

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Payment providers" lede="Mobile money and card providers, and every callback they sent." />
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading providers…</p> : null}
      {g?.simulator ? (
        <Notice>
          Providers are <strong>simulated</strong>: no real money moves. Charges {g.simulator.autoApproveSeconds ? `approve themselves after ${g.simulator.autoApproveSeconds} s` : "wait for the payment page"}, payouts
          finish after {g.simulator.payoutSeconds} s (an account ending in 0000 fails){g.simulator.dropWebhooks ? `, ${Math.round(g.simulator.dropWebhooks * 100)}% of callbacks are dropped to test reconciliation` : ""}.
        </Notice>
      ) : null}
      {g?.webhooks.unprocessed ? <Notice tone="error">{g.webhooks.unprocessed} callbacks haven't been processed for over a minute.</Notice> : null}
      {g && g.providers.length === 0 ? <Empty title="No providers are enabled.">Rider payments and top-ups by mobile money or card are off until one is configured.</Empty> : null}
      {g?.providers.length ? (
        <div className="stats">
          {g.providers.map((x) => {
            const refused = count(x.provider, false);
            const held = holds(x.provider);
            return (
              <div key={x.provider} className={`stat ${refused ? "urgent" : ""}`}>
                <span className="label">{x.label}</span>
                <div className="value" style={{ fontSize: "1.1rem" }}>{x.methods.map((m) => (m === "CARD" ? "cards" : "mobile money")).join(", ")}</div>
                <div className="sub">
                  {x.mode === "simulated" ? <Pill tone="amber">simulated</Pill> : <Pill tone="green">live</Pill>} {count(x.provider, true)} callbacks in 24 h{refused ? ` · ${refused} refused` : ""}
                  <div className="xs muted">last callback {lastAt(x.provider) ? dayAndTime(lastAt(x.provider)) : "not in the latest 30"}</div>
                  {held !== undefined ? <div className="xs muted">ledger: {birr(held)}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {overview.data ? <p className="xs muted" style={{ margin: 0 }}>Ledger: negative is money a provider collected for us and still holds; positive is payouts and refunds sent out of it.</p> : null}
      {g ? (
        <section className="card">
          <div className="card-head">
            <h2>Latest callbacks</h2>
            {recent.length ? <button className="btn ghost sm" onClick={() => download(csvName("provider-callbacks"), toCsv(recent, CALLBACK_CSV))}><Download /> CSV ({recent.length})</button> : null}
          </div>
          <div className="card-body row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <div className="chips">
              <button className="chip" aria-pressed={provider === ""} onClick={() => setProvider("")}>Every provider</button>
              {[...new Set([...g.providers.map((x) => x.provider), ...g.recent.map((w) => w.provider)])].map((x) => (
                <button key={x} className="chip" aria-pressed={provider === x} onClick={() => setProvider(x)}>{PROVIDER_LABEL[x] ?? x}</button>
              ))}
            </div>
            <div className="chips">
              <button className="chip" aria-pressed={only === ""} onClick={() => setOnly("")}>All</button>
              <button className="chip" aria-pressed={only === "refused"} onClick={() => setOnly("refused")}>Signature refused</button>
              <button className="chip" aria-pressed={only === "unprocessed"} onClick={() => setOnly("unprocessed")}>Not processed</button>
            </div>
          </div>
          {recent.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Received</th><th>Provider</th><th>Notification</th><th>Signature</th><th>Outcome</th><th>Took</th></tr></thead>
                <tbody>
                  {recent.map((w) => (
                    <tr key={w.id}>
                      <td className="small">{dayAndTime(w.receivedAt)}</td>
                      <td className="small">{PROVIDER_LABEL[w.provider] ?? w.provider}</td>
                      <td className="mono xs">{w.eventKey}</td>
                      <td>{w.signatureOk ? <Pill tone="green">valid</Pill> : <Pill tone="red">refused</Pill>}</td>
                      <td className="small">{w.outcome ?? (w.processedAt ? "" : <span className="muted">not processed yet</span>)}</td>
                      <td className="small muted">{took(w)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="card-body"><p className="small muted" style={{ margin: 0 }}>{g.recent.length ? "No callbacks match." : "No callbacks yet."}</p></div>}
        </section>
      ) : null}
    </div>
  );
}
