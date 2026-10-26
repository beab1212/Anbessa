// Builds a Gateway for a provider in "simulated" mode: requests go to the simulator, callbacks are
// read by the provider's own parser (signature included). A real adapter replaces the four
// request methods with HTTP calls to the provider and keeps the parser.

import type { Simulator, SimOperation } from "./simulator.js";
import type { ChargeMethod, Gateway, OperationKind, Provider, ProviderNotice } from "./types.js";

export interface ProviderSpec {
  provider: Provider;
  label: string;
  methods: readonly ChargeMethod[];
  /** what the payer is told after the charge starts */
  instructions(amountBirr: string): string;
  parse(rawBody: string, headers: Record<string, string | string[] | undefined>, secret: string): ProviderNotice;
}

export function simulatedGateway(spec: ProviderSpec, deps: { sim: Simulator; secret: string; checkoutBaseUrl: string }): Gateway {
  const { sim } = deps;
  const asNotice = (op: SimOperation): ProviderNotice => ({
    kind: op.kind, reference: op.reference, providerRef: op.ref, providerTxnId: op.txnId, status: op.status,
    amountMinor: op.amountMinor, ...(op.failure ? { failure: op.failure } : {}), eventKey: `query:${op.ref}:${op.status}`,
  });

  return {
    provider: spec.provider,
    label: spec.label,
    methods: spec.methods,
    mode: "simulated",

    async charge(req) {
      const op = await sim.charge(spec.provider, {
        reference: req.reference, amountMinor: req.amountMinor, description: req.description, notifyUrl: req.notifyUrl,
        ...(req.returnUrl ? { returnUrl: req.returnUrl } : {}),
      });
      return {
        providerRef: op.ref,
        checkoutUrl: `${deps.checkoutBaseUrl.replace(/\/$/, "")}/api/payments/sim/checkout/${op.ref}`,
        instructions: spec.instructions((req.amountMinor / 100).toFixed(2)),
      };
    },

    async payout(req) {
      const op = await sim.payout(spec.provider, {
        reference: req.reference, amountMinor: req.amountMinor, description: req.description, notifyUrl: req.notifyUrl, destination: req.destination,
      });
      return { providerRef: op.ref, status: op.status };
    },

    async refund(req) {
      const op = await sim.refund(spec.provider, { reference: req.reference, amountMinor: req.amountMinor, description: req.reason, notifyUrl: req.notifyUrl });
      return { providerRef: op.ref, status: op.status, providerTxnId: op.txnId };
    },

    async query(kind: OperationKind, reference: string) {
      const op = await sim.store.byReference(spec.provider, kind, reference);
      return op ? asNotice(op) : null;
    },

    parseWebhook: (rawBody, headers) => spec.parse(rawBody, headers, deps.secret),
  };
}
