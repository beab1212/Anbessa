// Who may see or act on which money (Payment.md §15, Role.md §8). A balance belongs to a driver
// (SELF) or a fleet company (ORG); staff see balances in their city or everywhere.

import { authorize, can, type Permission, type Principal } from "@ride-app/shared-authz";
import { notFound } from "../lib/errors.js";

export interface Owned {
  type: string;
  ownerId: string;
  cityId: string;
}

export const ownerScope = (b: Owned) =>
  b.type === "INDIVIDUAL" ? { ownerUserIds: [b.ownerId], cityId: b.cityId } : { orgId: b.ownerId, cityId: b.cityId };

/** The balance is readable by the caller, or it "doesn't exist" (never confirm someone else's). */
export function assertBalanceReadable(p: Principal, b: Owned) {
  if (!can(p, "balance:read", ownerScope(b))) throw notFound("balance");
}

/** Owners top up and set where payouts go (topup:create @ SELF / ORG). */
export function assertBalanceOwner(p: Principal, b: Owned) {
  assertBalanceReadable(p, b);
  authorize(p, "topup:create", b.type === "INDIVIDUAL" ? { ownerUserIds: [b.ownerId] } : { orgId: b.ownerId });
}

/** A rider's own payments (payment:read @ SELF), or staff who handle trips or money in that city. */
export function canSeePayment(p: Principal, pay: { riderId: string; cityId: string }) {
  if (p.audience === "ride-app") return can(p, "payment:read", { ownerUserIds: [pay.riderId] });
  return (["balance:read", "trip:read", "refund:request", "refund:approve"] as Permission[]).some((perm) => can(p, perm, { cityId: pay.cityId }));
}

/** Staff money pages: any of these, anywhere or in some city. */
export const FINANCE_VIEW: Permission[] = ["balance:read", "report:read_finance", "payout:prepare", "payout:approve", "refund:approve", "topup:record_cash", "topup:approve_cash", "system:read"];

export function assertFinanceView(p: Principal, cityId?: string) {
  if (p.audience !== "ride-admin" || !FINANCE_VIEW.some((perm) => can(p, perm, cityId ? { cityId } : {}))) {
    authorize(p, "balance:read", cityId ? { cityId } : {});
  }
}
