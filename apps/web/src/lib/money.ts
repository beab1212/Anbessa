// Shapes of payment-service answers (services/payment-service/src/money/*) and the words the money
// pages use for them.

export type BalanceState = "OK" | "WARNING" | "CASH_BLOCKED" | "BLOCKED";

export interface Balance {
  accountId: string | null;
  beneficiary: { type: "INDIVIDUAL" | "ORGANIZATION"; id: string };
  cityId: string;
  balanceMinor: number;
  currency: string;
  state: BalanceState;
  cashAllowed: boolean;
  stateChangedAt: string | null;
  overdueSince: string | null;
  referenceCode: string | null;
  payoutMethod: { provider: string; destination: string | null } | null;
  suggestedTopUpMinor: number;
  policy: { mode: string; warningMinor: number; cashLimitMinor: number; hardLimitMinor: number; prepaidMinimumMinor: number; minPayoutMinor: number; dueDays: number; builtIn: boolean };
  dues: { id: string; cycleEnd: string; amountMinor: number; minimumMinor: number; paidMinor: number; dueAt: string; status: string }[];
}

export interface BalanceRow {
  accountId: string;
  beneficiary: { type: "INDIVIDUAL" | "ORGANIZATION"; id: string };
  cityId: string;
  balanceMinor: number;
  state: BalanceState;
  cashAllowed: boolean;
  referenceCode: string;
  overdueSince: string | null;
  payoutReady: boolean;
}

export interface StatementEntry {
  id: string;
  at: string;
  amountMinor: number;
  kind: string;
  memo: string | null;
  reference: { type: string; id: string };
}

export interface Payment {
  id: string;
  purpose: "TRIP_FARE" | "CANCELLATION_FEE";
  tripId: string;
  riderId: string;
  cityId: string;
  method: "MOBILE_MONEY" | "CARD";
  provider: string;
  amountMinor: number;
  status: string;
  checkoutUrl: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  refundedMinor: number;
  settledAsReceivable: boolean;
  createdAt: string;
  completedAt: string | null;
  refunds?: Refund[];
}

export interface Refund {
  id: string;
  paymentId: string;
  amountMinor: number;
  reason: string;
  driverAtFault: boolean;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  decisionReason: string | null;
  failure: string | null;
  createdAt: string;
  payment?: Payment;
}

export interface TopUp {
  id: string;
  accountId: string;
  channel: "MOBILE_MONEY" | "BANK_TRANSFER" | "OFFICE_CASH";
  provider: string | null;
  amountMinor: number;
  status: string;
  checkoutUrl: string | null;
  receiptNo: string | null;
  note: string | null;
  failure: string | null;
  createdBy: string;
  approvedBy: string | null;
  createdAt: string;
  completedAt: string | null;
  instructions?: string | null;
}

export interface PayoutBatch {
  id: string;
  cycleEnd: string;
  status: string;
  preparedBy: string | null;
  approvedBy: string | null;
  rejectReason: string | null;
  totalMinor: number;
  lineCount: number;
  duesCreated: number;
  createdAt: string;
  lines?: { id: string; accountId: string; amountMinor: number; provider: string | null; destination: string | null; status: string; failure: string | null; beneficiary?: { type: string; id: string }; referenceCode?: string }[];
}

export interface RuleChange {
  id: string;
  kind: "COMMISSION_RULE" | "BALANCE_POLICY";
  cityId: string;
  payload: Record<string, unknown>;
  reason: string;
  makerId: string;
  checkerId: string | null;
  status: string;
  decisionReason: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface Provider {
  provider: string;
  label: string;
  methods: string[];
  mode: string;
}

export const STATE_LABEL: Record<BalanceState, string> = { OK: "OK", WARNING: "Warning", CASH_BLOCKED: "Cash paused", BLOCKED: "Blocked" };
export const stateTone = (s: string) => (s === "OK" ? "green" : s === "WARNING" ? "amber" : "red") as "green" | "amber" | "red";

export const PAYMENT_LABEL: Record<string, string> = {
  PENDING: "Starting", ACTION_REQUIRED: "Waiting for the payer", RETRY_SCHEDULED: "Will ask again", SUCCEEDED: "Paid",
  FAILED: "Failed (owed)", REFUNDED: "Refunded", PARTIALLY_REFUNDED: "Partly refunded",
};
export const paymentTone = (s: string) =>
  (s === "SUCCEEDED" ? "green" : s === "FAILED" ? "red" : s === "REFUNDED" || s === "PARTIALLY_REFUNDED" ? "grey" : "amber") as "green" | "red" | "grey" | "amber";

export const ENTRY_LABEL: Record<string, string> = {
  TRIP_SETTLEMENT: "Trip", CANCELLATION_FEE: "Cancellation fee", TOP_UP: "Top-up", PAYOUT: "Payout", PAYOUT_REVERSAL: "Payout returned",
  REFUND: "Refund", RECEIVABLE_COLLECTION: "Late payment",
};

export const CHANNEL_LABEL: Record<string, string> = { MOBILE_MONEY: "Mobile money", BANK_TRANSFER: "Bank transfer", OFFICE_CASH: "Cash at an office" };
export const PROVIDER_LABEL: Record<string, string> = { telebirr: "telebirr", cbebirr: "CBE Birr", chapa: "Chapa", bank: "Bank" };

/** Birr typed by a person → santim. */
export function toMinor(input: string): number | null {
  const v = Number(input.replace(/[\s,]/g, ""));
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100);
}

export const percent = (bp: number | null | undefined) => (bp === null || bp === undefined ? "—" : `${(bp / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`);
