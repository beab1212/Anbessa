// Shapes of payment-service answers (services/payment-service/src/money/*) and the words the money
// pages use for them, plus the small pure helpers they share (permission spread over cities,
// query strings, cursor paging, CSV export).

import { can, type Permission, type Principal } from "@ride-app/shared-authz";
import { CITIES } from "./format";

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
  decidedAt?: string | null;
  completedAt?: string | null;
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
  decidedAt?: string | null;
  lines?: PayoutLine[];
}

export interface PayoutLine {
  id: string;
  accountId: string;
  amountMinor: number;
  provider: string | null;
  destination: string | null;
  status: string;
  failure: string | null;
  updatedAt?: string;
  beneficiary?: { type: string; id: string };
  referenceCode?: string;
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
  decidedAt?: string | null;
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
  // money controls (payment-service, phase 2): mirrors CONTROL_ENTRY_LABEL in lib/money2.ts
  ADJUSTMENT: "Adjustment", WRITE_OFF: "Written off", INCENTIVE: "Incentive", INVOICE_PAYMENT: "Invoice payment",
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

export const REFUND_LABEL: Record<string, string> = {
  PENDING_APPROVAL: "waiting for approval", PROCESSING: "sending to the provider", SUCCEEDED: "refunded", FAILED: "failed", REJECTED: "rejected",
};
export const refundTone = (s: string) => (s === "SUCCEEDED" ? "green" : s === "FAILED" || s === "REJECTED" ? "red" : "amber") as "green" | "red" | "amber";

export const TOP_UP_LABEL: Record<string, string> = {
  PENDING: "starting", ACTION_REQUIRED: "waiting for the payer", SUCCEEDED: "credited", FAILED: "failed", PENDING_APPROVAL: "waiting for a finance manager", REJECTED: "rejected",
};
export const topUpTone = (s: string) => (s === "SUCCEEDED" ? "green" : s === "FAILED" || s === "REJECTED" ? "red" : "amber") as "green" | "red" | "amber";

export const BATCH_LABEL: Record<string, string> = { PENDING_APPROVAL: "waiting for approval", SENDING: "sending", COMPLETED: "done", REJECTED: "rejected" };
export const batchTone = (s: string) => (s === "COMPLETED" ? "green" : s === "REJECTED" ? "red" : "amber") as "green" | "red" | "amber";

export const CHANGE_LABEL: Record<string, string> = { PENDING: "waiting", EXECUTED: "approved", REJECTED: "rejected", CANCELLED: "withdrawn", EXPIRED: "expired" };

// ── permissions spread over cities ─────────────────────────────────────────

/** Held everywhere (no scope: a GLOBAL assignment), which is what the platform-wide money endpoints check. */
export const everywhere = (p: Principal | null, perm: Permission) => !!p && can(p, perm);

/** Held everywhere or in at least one city: the same test App.tsx uses for the money guards. */
export const inAnyCity = (p: Principal | null, perm: Permission) => !!p && (can(p, perm) || CITIES.some((cityId) => can(p, perm, { cityId })));

export const anyInAnyCity = (p: Principal | null, perms: Permission[]) => perms.some((perm) => inAnyCity(p, perm));

/** The cities (of `all`) where the principal holds at least one of `perms`. */
export const citiesWithAny = (p: Principal | null, perms: Permission[], all: string[] = CITIES) =>
  !p ? [] : all.filter((cityId) => perms.some((perm) => can(p, perm, { cityId })));

/** payment-service `cityFilter`: who may list payments and refunds (filtered to their cities). */
export const PAYMENT_READERS: Permission[] = ["balance:read", "report:read_finance", "refund:approve", "refund:request"];
/** Who may read a city's rules (`GET /api/payments/rules?cityId=`). */
export const RULE_VIEWERS: Permission[] = ["commission_rule:propose", "commission_rule:approve", "balance_policy:propose", "balance_policy:approve", "balance:read", "commission:read"];
/** Who gets anything from `GET /api/payments/rules/pending` (everyone else gets an empty list). */
export const RULE_DECIDERS: Permission[] = ["commission_rule:propose", "commission_rule:approve", "balance_policy:propose", "balance_policy:approve"];

/** `GET /api/payments/payouts` and `/payouts/:id` (no scope). */
export const canReadPayouts = (p: Principal | null) => ["payout:approve", "report:read_finance", "payout:prepare"].some((perm) => everywhere(p, perm as Permission));
/** `GET /api/payments/top-ups` and the pending list (no scope). */
export const canListTopUps = (p: Principal | null) => ["topup:record_cash", "topup:approve_cash", "balance:read"].some((perm) => everywhere(p, perm as Permission));

// ── query strings and cursor paging ────────────────────────────────────────

/** A query string from the set values only ("", null, undefined and false are left out). */
export function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "" && v !== null && v !== undefined && v !== false) q.set(k, String(v));
  return q.toString();
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

/** `before`-cursor pages ({ next: ISO | null }): the param for the following page, or undefined at the end. */
export const nextBefore = (last: { next: string | null }) => last.next ?? undefined;

/** Rows from several pages, without the duplicates a page boundary or a refetch can bring. */
export function joinPages<T extends { id: string }>(pages: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) for (const row of page) if (!seen.has(row.id)) { seen.add(row.id); out.push(row); }
  return out;
}

/** What a decision list shows under History: everything that is no longer waiting. */
export const decided = <T extends { status: string }>(rows: T[], waiting: string[] = ["PENDING_APPROVAL", "PENDING"]) => rows.filter((r) => !waiting.includes(r.status));

// ── CSV ────────────────────────────────────────────────────────────────────

/** One CSV field: quoted when needed; text that a spreadsheet would run as a formula is defused. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type CsvColumn<T> = [header: string, value: (row: T) => unknown];

/** Rows as CSV text (header line first, CRLF line ends, as spreadsheets expect). */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  return [columns.map(([h]) => csvCell(h)).join(","), ...rows.map((r) => columns.map(([, f]) => csvCell(f(r))).join(","))].join("\r\n") + "\r\n";
}

/** Santim → "123.50", the form a spreadsheet sums. */
export const birrPlain = (minor: number | null | undefined) => (minor === null || minor === undefined ? "" : (minor / 100).toFixed(2));

/** "payments-2026-10-27.csv" (the Addis Ababa date). */
export const csvName = (base: string, at = new Date()) => `${base}-${at.toLocaleDateString("en-CA", { timeZone: "Africa/Addis_Ababa" })}.csv`;

// ── CSV columns for what the pages show ────────────────────────────────────

export const PAYMENT_CSV: CsvColumn<Payment>[] = [
  ["created_at", (p) => p.createdAt], ["payment_id", (p) => p.id], ["trip_id", (p) => p.tripId], ["city", (p) => p.cityId],
  ["purpose", (p) => p.purpose], ["method", (p) => p.method], ["provider", (p) => p.provider], ["amount_etb", (p) => birrPlain(p.amountMinor)],
  ["refunded_etb", (p) => birrPlain(p.refundedMinor)], ["status", (p) => p.status], ["attempts", (p) => p.attempts], ["completed_at", (p) => p.completedAt],
];

export const BALANCE_CSV: CsvColumn<BalanceRow>[] = [
  ["account_id", (b) => b.accountId], ["type", (b) => b.beneficiary.type], ["owner_id", (b) => b.beneficiary.id], ["city", (b) => b.cityId],
  ["balance_etb", (b) => birrPlain(b.balanceMinor)], ["state", (b) => b.state], ["reference_code", (b) => b.referenceCode],
  ["overdue_since", (b) => b.overdueSince], ["payout_method_set", (b) => b.payoutReady],
];

export const STATEMENT_CSV: CsvColumn<StatementEntry>[] = [
  ["at", (e) => e.at], ["kind", (e) => e.kind], ["memo", (e) => e.memo], ["amount_etb", (e) => birrPlain(e.amountMinor)],
  ["reference_type", (e) => e.reference.type], ["reference_id", (e) => e.reference.id],
];

export const PAYOUT_LINE_CSV: CsvColumn<PayoutLine>[] = [
  ["line_id", (l) => l.id], ["account_id", (l) => l.accountId], ["type", (l) => l.beneficiary?.type], ["owner_id", (l) => l.beneficiary?.id],
  ["reference_code", (l) => l.referenceCode], ["provider", (l) => l.provider], ["destination", (l) => l.destination],
  ["amount_etb", (l) => birrPlain(l.amountMinor)], ["status", (l) => l.status], ["failure", (l) => l.failure], ["updated_at", (l) => l.updatedAt],
];

/** Payout lines by status: how many and how much (for a batch's summary). */
export function lineTotals(lines: Pick<PayoutLine, "status" | "amountMinor">[]): Record<string, { count: number; amountMinor: number }> {
  const out: Record<string, { count: number; amountMinor: number }> = {};
  for (const l of lines) {
    const t = (out[l.status] ??= { count: 0, amountMinor: 0 });
    t.count += 1;
    t.amountMinor += l.amountMinor;
  }
  return out;
}

export const REFUND_CSV: CsvColumn<Refund>[] = [
  ["requested_at", (r) => r.createdAt], ["refund_id", (r) => r.id], ["payment_id", (r) => r.paymentId], ["trip_id", (r) => r.payment?.tripId],
  ["city", (r) => r.payment?.cityId], ["amount_etb", (r) => birrPlain(r.amountMinor)], ["payment_etb", (r) => birrPlain(r.payment?.amountMinor)],
  ["driver_at_fault", (r) => r.driverAtFault], ["reason", (r) => r.reason], ["status", (r) => r.status], ["requested_by", (r) => r.requestedBy],
  ["decided_by", (r) => r.approvedBy], ["decided_at", (r) => r.decidedAt], ["decision_reason", (r) => r.decisionReason], ["failure", (r) => r.failure],
];

export const TOP_UP_CSV: CsvColumn<TopUp>[] = [
  ["created_at", (t) => t.createdAt], ["top_up_id", (t) => t.id], ["account_id", (t) => t.accountId], ["channel", (t) => t.channel],
  ["provider", (t) => t.provider], ["amount_etb", (t) => birrPlain(t.amountMinor)], ["status", (t) => t.status], ["receipt_no", (t) => t.receiptNo],
  ["note", (t) => t.note], ["recorded_by", (t) => t.createdBy], ["approved_by", (t) => t.approvedBy], ["completed_at", (t) => t.completedAt], ["failure", (t) => t.failure],
];
