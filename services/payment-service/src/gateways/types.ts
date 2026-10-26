// What payment-service needs from a payment provider. Every provider adapter (telebirr.ts,
// cbebirr.ts, chapa.ts) implements this. Today they all run in "simulated" mode against
// simulator.ts, which reproduces each provider's callback format and signature, so the rest of
// payment-service (webhooks, reconciliation, the ledger) is the code that will run against the real
// providers. Replacing a simulated adapter with a real one only touches that adapter file.

export const PROVIDERS = ["telebirr", "cbebirr", "chapa"] as const;
export type Provider = (typeof PROVIDERS)[number];

export type ChargeMethod = "MOBILE_MONEY" | "CARD";
export type OperationKind = "charge" | "payout" | "refund";
export type ProviderStatus = "PENDING" | "SUCCEEDED" | "FAILED";

export interface ChargeRequest {
  /** our id for the operation (ANBP…, ANBT…); the provider echoes it in every callback */
  reference: string;
  amountMinor: number;
  currency: "ETB";
  description: string;
  /** where the provider posts the result */
  notifyUrl: string;
  /** where the payer's browser goes after paying (hosted checkout) */
  returnUrl?: string;
}

export interface ChargeStarted {
  /** the provider's id for the charge (prepay id, checkout id, conversation id) */
  providerRef: string;
  /** hosted checkout page, when the provider has one */
  checkoutUrl: string | null;
  /** what to tell the payer */
  instructions: string;
}

export interface PayoutRequest {
  reference: string;
  amountMinor: number;
  currency: "ETB";
  /** phone number (mobile money) or bank account */
  destination: string;
  description: string;
  notifyUrl: string;
}

export interface RefundRequest {
  reference: string;
  /** the charge being refunded */
  chargeReference: string;
  providerTxnId: string | null;
  amountMinor: number;
  reason: string;
  notifyUrl: string;
}

/** A provider's word on an operation: from a webhook or a status query. */
export interface ProviderNotice {
  kind: OperationKind;
  reference: string;
  providerRef: string | null;
  providerTxnId: string | null;
  status: ProviderStatus;
  amountMinor: number;
  failure?: string;
  /** the provider's id for this notification: a redelivery repeats it */
  eventKey: string;
}

export interface Gateway {
  provider: Provider;
  label: string;
  methods: readonly ChargeMethod[];
  /** "simulated" until the real integration exists */
  mode: "simulated";
  charge(req: ChargeRequest): Promise<ChargeStarted>;
  payout(req: PayoutRequest): Promise<{ providerRef: string; status: ProviderStatus; failure?: string }>;
  refund(req: RefundRequest): Promise<{ providerRef: string; status: ProviderStatus; providerTxnId: string | null; failure?: string }>;
  /** reconciliation: ask the provider for the state of an operation */
  query(kind: OperationKind, reference: string): Promise<ProviderNotice | null>;
  /** verify the signature and read a callback; throws WebhookRejected */
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderNotice;
}

export class WebhookRejected extends Error {}

export const toBirr = (minor: number) => (minor / 100).toFixed(2);
export const toMinor = (birr: string | number) => Math.round(Number(birr) * 100);

/**
 * Our references: ANB + a kind letter + the row id, alphanumeric so every provider accepts them.
 * A charge tried again gets a new reference (N2, N3…): providers refuse a reference twice.
 */
export const REF_KINDS = { P: "payment", T: "topup", O: "payout", R: "refund" } as const;
export type RefKind = (typeof REF_KINDS)[keyof typeof REF_KINDS];

export function makeReference(kind: RefKind, id: string, attempt = 1): string {
  const letter = Object.entries(REF_KINDS).find(([, v]) => v === kind)![0];
  return `ANB${letter}${id.replaceAll("-", "")}${attempt > 1 ? `N${attempt}` : ""}`;
}

export function parseReference(reference: string): { kind: RefKind; id: string; attempt: number } | null {
  const m = /^ANB([PTOR])([0-9a-f]{32})(?:N(\d{1,3}))?$/.exec(reference);
  if (!m) return null;
  const h = m[2]!;
  return {
    kind: REF_KINDS[m[1] as keyof typeof REF_KINDS],
    id: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    attempt: m[3] ? Number(m[3]) : 1,
  };
}

export const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
