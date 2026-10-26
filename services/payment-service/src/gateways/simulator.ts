// A stand-in for the payment providers, for development and tests (refused in production). It
// keeps the operations it was asked for and, when one is decided, posts the provider's own
// callback (format and signature from the adapter's codec) to payment-service's webhook, as
// the real provider would:
//
//   charges   wait for the payer: the hosted checkout page (Approve / Decline), or approved
//             automatically after SIM_AUTO_APPROVE_SECONDS (the rider "approves on their phone")
//   payouts   succeed after SIM_PAYOUT_SECONDS; a destination ending in 0000 fails ("account closed")
//   refunds   succeed at once
//
// SIM_DROP_WEBHOOKS (0–1) drops that share of callbacks, to exercise reconciliation.

import { randomBytes } from "node:crypto";
import type { Logger } from "@ride-app/shared-utils";
import type { OperationKind, Provider, ProviderStatus } from "./types.js";

export interface SimOperation {
  /** the provider's id (returned as providerRef) */
  ref: string;
  provider: Provider;
  kind: OperationKind;
  /** our reference (ANB…) */
  reference: string;
  amountMinor: number;
  description: string;
  status: ProviderStatus;
  /** the provider's transaction id once it succeeded */
  txnId: string | null;
  failure?: string;
  notifyUrl: string;
  returnUrl?: string;
  destination?: string;
  createdAt: number;
  decidedAt?: number;
}

/** How a provider's callback looks: built here by the simulator, read by the adapter. */
export interface SimCodec {
  provider: Provider;
  newRef(): string;
  newTxnId(): string;
  notice(op: SimOperation, secret: string): { body: string; headers: Record<string, string> };
}

export interface SimStore {
  get(ref: string): Promise<SimOperation | null>;
  byReference(provider: Provider, kind: OperationKind, reference: string): Promise<SimOperation | null>;
  put(op: SimOperation): Promise<void>;
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

const DAY = 86_400;

/** Redis keeps simulated operations across restarts (tsx watch restarts often); a Map otherwise. */
export function simStore(redis?: RedisLike): SimStore {
  const mem = new Map<string, string>();
  const read = async (k: string) => (redis ? redis.get(k) : mem.get(k) ?? null);
  const write = async (k: string, v: string) => {
    if (redis) await redis.set(k, v, "EX", 7 * DAY);
    else mem.set(k, v);
  };
  return {
    async get(ref) {
      const raw = await read(`sim:op:${ref}`);
      return raw ? (JSON.parse(raw) as SimOperation) : null;
    },
    async byReference(provider, kind, reference) {
      const ref = await read(`sim:ref:${provider}:${kind}:${reference}`);
      return ref ? this.get(ref) : null;
    },
    async put(op) {
      await write(`sim:op:${op.ref}`, JSON.stringify(op));
      await write(`sim:ref:${op.provider}:${op.kind}:${op.reference}`, op.ref);
    },
  };
}

export type Deliver = (url: string, body: string, headers: Record<string, string>) => Promise<number>;

export const httpDeliver: Deliver = async (url, body, headers) => {
  const res = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(5000) });
  return res.status;
};

export interface SimulatorOptions {
  store: SimStore;
  codecs: Record<Provider, SimCodec>;
  secrets: Record<Provider, string>;
  deliver: Deliver;
  logger: Logger;
  /** 0 = charges wait for the checkout page */
  autoApproveMs: number;
  payoutDelayMs: number;
  dropRate: number;
  /** retry delays for a callback that didn't get a 2xx */
  redeliverMs?: number[];
}

export function createSimulator(opts: SimulatorOptions) {
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => Promise<unknown>) => {
    const t = setTimeout(() => {
      timers.delete(t);
      void fn().catch((err) => opts.logger.warn({ err: (err as Error).message }, "simulator: scheduled step failed"));
    }, ms);
    t.unref?.();
    timers.add(t);
  };

  async function notify(op: SimOperation, attempt = 0): Promise<void> {
    if (attempt === 0 && opts.dropRate > 0 && Math.random() < opts.dropRate) {
      opts.logger.info({ provider: op.provider, reference: op.reference }, "simulator: dropped the callback on purpose (SIM_DROP_WEBHOOKS)");
      return;
    }
    const { body, headers } = opts.codecs[op.provider].notice(op, opts.secrets[op.provider]);
    let status = 0;
    try {
      status = await opts.deliver(op.notifyUrl, body, headers);
    } catch (err) {
      opts.logger.warn({ err: (err as Error).message, provider: op.provider }, "simulator: callback not delivered");
    }
    if (status >= 200 && status < 300) return;
    const delays = opts.redeliverMs ?? [1000, 5000, 15_000];
    if (attempt < delays.length) later(delays[attempt]!, () => notify(op, attempt + 1));
  }

  async function create(input: Omit<SimOperation, "ref" | "status" | "txnId" | "createdAt">): Promise<SimOperation> {
    const codec = opts.codecs[input.provider];
    const op: SimOperation = { ...input, ref: codec.newRef(), status: "PENDING", txnId: null, createdAt: Date.now() };
    await opts.store.put(op);
    return op;
  }

  /** The payer (or the provider) decides; the result goes to the notify URL. Idempotent. */
  async function decide(ref: string, status: "SUCCEEDED" | "FAILED", failure?: string): Promise<SimOperation | null> {
    const op = await opts.store.get(ref);
    if (!op) return null;
    if (op.status !== "PENDING") return op;
    op.status = status;
    op.decidedAt = Date.now();
    if (status === "SUCCEEDED") op.txnId = opts.codecs[op.provider].newTxnId();
    else op.failure = failure ?? "declined by the payer";
    await opts.store.put(op);
    await notify(op);
    return op;
  }

  return {
    store: opts.store,
    autoApproveMs: opts.autoApproveMs,

    async charge(provider: Provider, input: { reference: string; amountMinor: number; description: string; notifyUrl: string; returnUrl?: string }) {
      const op = await create({ provider, kind: "charge", ...input });
      if (opts.autoApproveMs > 0) later(opts.autoApproveMs, () => decide(op.ref, "SUCCEEDED"));
      return op;
    },

    async payout(provider: Provider, input: { reference: string; amountMinor: number; description: string; notifyUrl: string; destination: string }) {
      const op = await create({ provider, kind: "payout", ...input });
      const closed = /0000$/.test(input.destination.replace(/\D/g, ""));
      later(opts.payoutDelayMs, () => decide(op.ref, closed ? "FAILED" : "SUCCEEDED", closed ? "the receiving account is closed" : undefined));
      return op;
    },

    async refund(provider: Provider, input: { reference: string; amountMinor: number; description: string; notifyUrl: string }) {
      const op = await create({ provider, kind: "refund", ...input });
      op.status = "SUCCEEDED";
      op.txnId = opts.codecs[provider].newTxnId();
      op.decidedAt = Date.now();
      await opts.store.put(op);
      return op;
    },

    decide,
    /** send the callback again (the checkout page's "resend", tests) */
    async resend(ref: string) {
      const op = await opts.store.get(ref);
      if (op && op.status !== "PENDING") await notify(op, 1);
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

export type Simulator = ReturnType<typeof createSimulator>;

/** Random uppercase letters and digits, like provider transaction ids. */
export function providerId(prefix: string, length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return prefix + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
