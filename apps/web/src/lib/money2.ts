// Shapes of payment-service's money controls (services/payment-service/src/money/{adjustments,
// write-offs,policy-overrides,incentives,invoices}.ts), the words the pages use for them, who may
// see which page, and the small pure helpers they share (months, datetimes, CSV columns).

import type { Permission, Principal } from "@ride-app/shared-authz";
import { birr } from "./format";
import { birrPlain, everywhere, inAnyCity, type BalanceState, type CsvColumn } from "./money";

interface Owner {
  beneficiary?: { type: "INDIVIDUAL" | "ORGANIZATION"; id: string };
  referenceCode?: string;
  balanceMinor?: number;
  state?: BalanceState;
}

export type Direction = "CREDIT" | "DEBIT";
export type AdjustmentCategory = "GOODWILL" | "FEE_REVERSAL" | "CORRECTION" | "LOST_ITEM_RETURN" | "OTHER";

export interface Adjustment extends Owner {
  id: string;
  accountId: string;
  cityId: string;
  direction: Direction;
  amountMinor: number;
  category: AdjustmentCategory;
  reason: string;
  ticketId: string | null;
  tripId: string | null;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  journalEntryId: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export interface WriteOff extends Owner {
  id: string;
  accountId: string;
  cityId: string;
  amountMinor: number;
  reason: string;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  journalEntryId: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export interface WriteOffCandidate {
  accountId: string;
  beneficiary: { type: "INDIVIDUAL" | "ORGANIZATION"; id: string };
  cityId: string;
  referenceCode: string;
  state: BalanceState;
  balanceMinor: number;
  overdueSince: string | null;
  overdueDays: number | null;
}

export interface PolicyOverride extends Owner {
  id: string;
  accountId: string;
  cityId: string;
  mode: "POSTPAID" | "PREPAID" | null;
  warningMinor: number | null;
  cashLimitMinor: number | null;
  hardLimitMinor: number | null;
  prepaidMinimumMinor: number | null;
  validFrom: string;
  validUntil: string;
  reason: string;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
  inForce: boolean;
}

export interface IncentiveProgram {
  id: string;
  cityId: string;
  name: string;
  vehicleType: string | null;
  targetTrips: number;
  rewardMinor: number;
  budgetMinor: number;
  startsAt: string;
  endsAt: string;
  reason: string;
  status: string;
  proposedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
  closedAt: string | null;
  qualifiedCount: number;
  awardsCount: number;
  spentMinor: number;
}

export interface IncentiveDetail extends IncentiveProgram {
  progress: { driverId: string; beneficiaryAccountId: string; trips: number; reachedAt: string | null; reached: boolean }[];
  awards: { id: string; driverId: string; accountId: string; trips: number; amountMinor: number; journalEntryId: string; createdAt: string }[];
}

export interface Invoice {
  id: string;
  orgId: string;
  period: string;
  number: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  totalMinor: number;
  lineCount: number;
  paidMinor: number;
  outstandingMinor: number;
  status: "ISSUED" | "PAID";
  overdue: boolean;
  issuedBy: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
}

export interface InvoiceLine {
  id: string;
  at: string;
  kind: string;
  tripId: string | null;
  purpose: string | null;
  riderId: string | null;
  cityId: string | null;
  vehicleType: string | null;
  amountMinor: number;
}

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[];
  payments: { id: string; amountMinor: number; bankReference: string; createdAt: string; recordedBy?: string }[];
}

export interface Uninvoiced {
  period: string;
  periodStart: string;
  periodEnd: string;
  open: boolean;
  companies: { orgId: string; lines: number; totalMinor: number; firstAt: string; lastAt: string }[];
}

/** GET /api/payments/approvals/pending */
export interface PendingControls {
  adjustments: Adjustment[];
  writeOffs: WriteOff[];
  overrides: PolicyOverride[];
  incentives: IncentiveProgram[];
}

// ── words ──────────────────────────────────────────────────────────────────

export const CATEGORY_LABEL: Record<AdjustmentCategory, string> = {
  GOODWILL: "Goodwill", FEE_REVERSAL: "Fee reversed", CORRECTION: "Correction", LOST_ITEM_RETURN: "Lost item return", OTHER: "Other",
};
export const CATEGORIES = Object.keys(CATEGORY_LABEL) as AdjustmentCategory[];

/** Requests that wait for a second person (adjustments, write-offs, overrides, incentives). */
export const REQUEST_LABEL: Record<string, string> = {
  PENDING_APPROVAL: "waiting for approval", EXECUTED: "done", APPROVED: "approved", REJECTED: "rejected", CANCELLED: "withdrawn",
  EXPIRED: "expired", REVOKED: "revoked", CLOSED: "closed and paid",
};
export const requestTone = (s: string) =>
  (s === "EXECUTED" || s === "APPROVED" || s === "CLOSED" ? "green" : s === "REJECTED" ? "red" : s === "PENDING_APPROVAL" ? "amber" : "grey") as "green" | "red" | "amber" | "grey";

export const INVOICE_LABEL: Record<string, string> = { ISSUED: "issued", PAID: "paid" };
export const invoiceTone = (i: Pick<Invoice, "status" | "overdue">) => (i.status === "PAID" ? "green" : i.overdue ? "red" : "amber") as "green" | "red" | "amber";

/** Ledger entry kinds these features post (to merge into money.ts ENTRY_LABEL). */
export const CONTROL_ENTRY_LABEL: Record<string, string> = {
  ADJUSTMENT: "Adjustment", WRITE_OFF: "Written off", INCENTIVE: "Incentive", INVOICE_PAYMENT: "Invoice payment",
};

/** "+50.00 ETB" / "−20.00 ETB": the way the balance moves. */
export const signedBirr = (direction: Direction, amountMinor: number) => `${direction === "CREDIT" ? "+" : "−"}${birr(amountMinor)}`;

/** What an override changes, in words. */
export function describeOverride(o: Pick<PolicyOverride, "mode" | "warningMinor" | "cashLimitMinor" | "hardLimitMinor" | "prepaidMinimumMinor">): string {
  const parts: string[] = [];
  if (o.mode) parts.push(o.mode === "PREPAID" ? "prepaid" : "postpaid");
  if (o.prepaidMinimumMinor !== null) parts.push(`prepaid minimum ${birr(o.prepaidMinimumMinor)}`);
  if (o.warningMinor !== null) parts.push(`warning ${birr(o.warningMinor)}`);
  if (o.cashLimitMinor !== null) parts.push(`cash paused ${birr(o.cashLimitMinor)}`);
  if (o.hardLimitMinor !== null) parts.push(`blocked ${birr(o.hardLimitMinor)}`);
  return parts.join(", ") || "no change";
}

export const describeIncentive = (x: Pick<IncentiveProgram, "targetTrips" | "rewardMinor" | "vehicleType">) =>
  `${x.targetTrips} ${x.vehicleType ? `${x.vehicleType} ` : ""}trip${x.targetTrips === 1 ? "" : "s"} → ${birr(x.rewardMinor)}`;

// ── the limits payment-service checks (src/money/controls.ts), for hints ──

export const LIMITS = {
  adjustmentCityStaffMaxMinor: 100_000,
  adjustmentMaxMinor: 5_000_000,
  adjustmentCreditPer30DaysMinor: 1_000_000,
  overrideHardLimitFloorMinor: -1_000_000,
  overrideMaxDays: 90,
  incentiveMaxRewardMinor: 1_000_000,
  incentiveMaxBudgetMinor: 100_000_000,
  incentiveMaxDays: 31,
};

// ── who sees which page (the same tests the server applies) ─────────────────

export const ADJUSTMENT_VIEWERS: Permission[] = ["adjustment:request", "adjustment:approve", "balance:read"];
export const WRITE_OFF_VIEWERS: Permission[] = ["writeoff:request", "writeoff:approve", "balance:read"];
export const OVERRIDE_VIEWERS: Permission[] = ["policy_override:request", "policy_override:approve", "balance:read"];
export const INCENTIVE_VIEWERS: Permission[] = ["incentive:propose", "incentive:approve", "report:read_finance"];
/** GET /api/payments/approvals/pending answers something for these. */
export const CONTROL_DECIDERS: Permission[] = [
  "adjustment:request", "adjustment:approve", "writeoff:request", "writeoff:approve", "policy_override:request", "policy_override:approve",
  "incentive:propose", "incentive:approve",
];

const anyIn = (p: Principal | null, perms: Permission[]) => perms.some((perm) => inAnyCity(p, perm));
export const canSeeAdjustments = (p: Principal | null) => anyIn(p, ADJUSTMENT_VIEWERS);
export const canSeeWriteOffs = (p: Principal | null) => anyIn(p, WRITE_OFF_VIEWERS);
export const canSeeOverrides = (p: Principal | null) => anyIn(p, OVERRIDE_VIEWERS);
export const canSeeIncentives = (p: Principal | null) => anyIn(p, INCENTIVE_VIEWERS);
/** Finance-wide invoice pages (invoice:issue or report:read_finance, no scope). */
export const canSeeInvoices = (p: Principal | null) => everywhere(p, "invoice:issue") || everywhere(p, "report:read_finance");
export const canDecideControls = (p: Principal | null) => anyIn(p, CONTROL_DECIDERS);

// ── months and times ───────────────────────────────────────────────────────

const ADDIS_OFFSET_MS = 3 * 3600_000;

/** The Addis Ababa month a moment falls in, YYYY-MM. */
export const addisPeriod = (at: Date | number = Date.now()) => new Date(new Date(at).getTime() + ADDIS_OFFSET_MS).toISOString().slice(0, 7);

/** The month before (YYYY-MM): what finance invoices at the start of a month. */
export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** The last `n` months up to `period`, newest first. */
export function recentPeriods(period: string, n = 12): string[] {
  const out = [period];
  while (out.length < n) out.push(previousPeriod(out.at(-1)!));
  return out;
}

/** "October 2026". */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** A `datetime-local` input value (the browser's time) → ISO, or null when empty or invalid. */
export function localToIso(v: string): string | null {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** ISO → a `datetime-local` value in the browser's time. */
export function isoToLocal(iso: string | number | Date): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Birr typed by a person (may be negative, for limits) → santim; null when empty or not a number. */
export function signedMinor(input: string): number | null {
  const s = input.replace(/[\s,]/g, "").replace("−", "-");
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

// ── CSV ────────────────────────────────────────────────────────────────────

export const ADJUSTMENT_CSV: CsvColumn<Adjustment>[] = [
  ["requested_at", (a) => a.createdAt], ["adjustment_id", (a) => a.id], ["account_id", (a) => a.accountId], ["reference_code", (a) => a.referenceCode],
  ["city", (a) => a.cityId], ["direction", (a) => a.direction], ["amount_etb", (a) => birrPlain(a.amountMinor)], ["category", (a) => a.category],
  ["reason", (a) => a.reason], ["ticket", (a) => a.ticketId], ["trip_id", (a) => a.tripId], ["status", (a) => a.status], ["requested_by", (a) => a.requestedBy],
  ["decided_by", (a) => a.decidedBy], ["decided_at", (a) => a.decidedAt], ["decision_reason", (a) => a.decisionReason],
];

export const WRITE_OFF_CSV: CsvColumn<WriteOff>[] = [
  ["requested_at", (w) => w.createdAt], ["write_off_id", (w) => w.id], ["account_id", (w) => w.accountId], ["reference_code", (w) => w.referenceCode],
  ["city", (w) => w.cityId], ["amount_etb", (w) => birrPlain(w.amountMinor)], ["reason", (w) => w.reason], ["status", (w) => w.status],
  ["requested_by", (w) => w.requestedBy], ["decided_by", (w) => w.decidedBy], ["decided_at", (w) => w.decidedAt], ["decision_reason", (w) => w.decisionReason],
];

export const INVOICE_CSV: CsvColumn<Invoice>[] = [
  ["number", (i) => i.number], ["org_id", (i) => i.orgId], ["period", (i) => i.period], ["total_etb", (i) => birrPlain(i.totalMinor)],
  ["paid_etb", (i) => birrPlain(i.paidMinor)], ["outstanding_etb", (i) => birrPlain(i.outstandingMinor)], ["status", (i) => i.status],
  ["overdue", (i) => i.overdue], ["lines", (i) => i.lineCount], ["issued_at", (i) => i.issuedAt], ["due_at", (i) => i.dueAt], ["paid_at", (i) => i.paidAt],
];
