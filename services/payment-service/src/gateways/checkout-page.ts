// The simulator's hosted checkout page (development only): what a payer would see at telebirr,
// CBE Birr or Chapa. No scripts, so the default Content-Security-Policy holds.

import type { SimOperation } from "./simulator.js";

const BRAND: Record<string, { name: string; color: string; ask: string }> = {
  telebirr: { name: "telebirr", color: "#0d8f3d", ask: "Enter your telebirr PIN to approve" },
  cbebirr: { name: "CBE Birr", color: "#6b2a8c", ask: "Enter your CBE Birr PIN to approve" },
  chapa: { name: "Chapa", color: "#7dc400", ask: "Card number (any digits work here)" },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function checkoutPage(op: SimOperation, action: string): string {
  const b = BRAND[op.provider] ?? { name: op.provider, color: "#333", ask: "Approve" };
  const amount = (op.amountMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
  const done = op.status !== "PENDING";
  const result = op.status === "SUCCEEDED" ? "Payment approved." : op.status === "FAILED" ? `Payment declined: ${esc(op.failure ?? "")}` : "";
  const back = op.returnUrl ? `<p><a href="${esc(op.returnUrl)}">Back to Anbessa</a></p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(b.name)} · Pay Anbessa (simulated)</title>
<style>
  body { margin: 0; font: 16px/1.45 system-ui, sans-serif; background: #f3f4f6; color: #111; }
  main { max-width: 420px; margin: 0 auto; padding: 24px 16px; }
  .card { background: #fff; border-radius: 14px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  .brand { color: #fff; background: ${b.color}; border-radius: 10px; padding: 10px 14px; font-weight: 700; letter-spacing: .02em; }
  .amount { font-size: 2rem; font-weight: 700; margin: 16px 0 2px; }
  .muted { color: #6b7280; font-size: .9rem; }
  .sim { background: #fff7ed; border: 1px solid #fdba74; color: #9a3412; border-radius: 8px; padding: 8px 10px; font-size: .85rem; margin-bottom: 14px; }
  label { display: block; margin: 16px 0 6px; font-size: .9rem; }
  input { width: 100%; box-sizing: border-box; font-size: 1rem; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; }
  .row { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  button { flex: 1 1 120px; font-size: 1rem; padding: 11px; border-radius: 8px; border: 0; cursor: pointer; }
  .pay { background: ${b.color}; color: #fff; font-weight: 600; }
  .decline { background: #e5e7eb; }
  .result { margin-top: 16px; font-weight: 600; }
</style></head>
<body><main>
  <div class="sim">Simulated ${esc(b.name)} checkout. No real money moves. Replace with the real integration before launch.</div>
  <div class="card">
    <div class="brand">${esc(b.name)}</div>
    <div class="amount">${amount} ETB</div>
    <div class="muted">To Anbessa · ${esc(op.description)}</div>
    <div class="muted">Reference ${esc(op.reference)}</div>
    ${done ? `<p class="result">${result}</p>${back}` : `
    <form method="post" action="${esc(action)}">
      <label for="secret">${esc(b.ask)}</label>
      <input id="secret" name="secret" inputmode="numeric" autocomplete="off" placeholder="${op.provider === "chapa" ? "4242 4242 4242 4242" : "••••"}">
      <div class="row">
        <button class="pay" name="decision" value="approve">Pay ${amount} ETB</button>
        <button class="decline" name="decision" value="decline">Decline</button>
        <button class="decline" name="decision" value="insufficient">Insufficient funds</button>
      </div>
    </form>`}
  </div>
</main></body></html>`;
}
