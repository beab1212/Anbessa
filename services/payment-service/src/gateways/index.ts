// The providers payment-service can use, built from config. Each is simulated until its real
// adapter exists (see the header of telebirr.ts, cbebirr.ts and chapa.ts).

import type { Logger } from "@ride-app/shared-utils";
import { cbebirrCodec, cbebirrSpec } from "./cbebirr.js";
import { chapaCodec, chapaSpec } from "./chapa.js";
import { simulatedGateway } from "./simulated.js";
import { createSimulator, type Deliver, type SimStore } from "./simulator.js";
import { telebirrCodec, telebirrSpec } from "./telebirr.js";
import type { Gateway, Provider } from "./types.js";

export * from "./types.js";

export interface GatewayConfig {
  providers: Provider[];
  secrets: Record<Provider, string>;
  /** where the payer's browser reaches the (simulated) hosted checkout */
  checkoutBaseUrl: string;
  autoApproveMs: number;
  payoutDelayMs: number;
  dropRate: number;
}

export function createGateways(config: GatewayConfig, deps: { store: SimStore; deliver: Deliver; logger: Logger }) {
  const simulator = createSimulator({
    store: deps.store, deliver: deps.deliver, logger: deps.logger, secrets: config.secrets,
    codecs: { telebirr: telebirrCodec, cbebirr: cbebirrCodec, chapa: chapaCodec },
    autoApproveMs: config.autoApproveMs, payoutDelayMs: config.payoutDelayMs, dropRate: config.dropRate,
  });
  const specs = { telebirr: telebirrSpec, cbebirr: cbebirrSpec, chapa: chapaSpec };
  const gateways = new Map<Provider, Gateway>(
    config.providers.map((p) => [p, simulatedGateway(specs[p], { sim: simulator, secret: config.secrets[p], checkoutBaseUrl: config.checkoutBaseUrl })]),
  );

  return {
    simulator,
    list: () => [...gateways.values()],
    has: (p: string): p is Provider => gateways.has(p as Provider),
    get(p: string): Gateway {
      const g = gateways.get(p as Provider);
      if (!g) throw new Error(`payment provider ${p} is not enabled`);
      return g;
    },
  };
}

export type Gateways = ReturnType<typeof createGateways>;
