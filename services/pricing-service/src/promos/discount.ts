// The discount a promo gives on one fare: pure, so quotes and tests agree.

export interface DiscountRule {
  type: "PERCENT_OFF" | "AMOUNT_OFF";
  percentOff: number | null;
  amountOffMinor: number | null;
  maxDiscountMinor: number | null;
}

/** Percent discounts round down to whole birr; never more than the fare or the per-trip cap. */
export function discountFor(rule: DiscountRule, fareMinor: number): number {
  let d = rule.type === "PERCENT_OFF"
    ? Math.floor(((fareMinor * (rule.percentOff ?? 0)) / 100) / 100) * 100
    : (rule.amountOffMinor ?? 0);
  if (rule.maxDiscountMinor !== null) d = Math.min(d, rule.maxDiscountMinor);
  return Math.max(0, Math.min(d, fareMinor));
}

export type PromoRejection =
  | "unknown_code"
  | "not_active"
  | "not_started"
  | "expired"
  | "exhausted"
  | "not_in_city"
  | "vehicle_type_not_eligible"
  | "limit_reached";

export const REJECTION_MESSAGES: Record<PromoRejection, string> = {
  unknown_code: "This code doesn't exist.",
  not_active: "This code isn't active.",
  not_started: "This code isn't valid yet.",
  expired: "This code has expired.",
  exhausted: "This code has been used up.",
  not_in_city: "This code isn't valid in this city.",
  vehicle_type_not_eligible: "This code isn't valid for these vehicle types.",
  limit_reached: "You've already used this code.",
};
