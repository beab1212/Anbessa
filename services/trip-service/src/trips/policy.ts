// Trip rules that cost or pay money (workflows 06 and 07). The values are live settings
// (platform-service, libs/shared-settings), per city; fee changes need a second super admin.

import type { SettingsReader } from "@ride-app/shared-settings";

export interface CityPolicy {
  /** driver must be this close to the pickup to tap "Arrived" / start (workflow 06 §6) */
  arrivalRadiusMeters: number;
  freeWaitingSeconds: number;
  /** driver may report a no-show this long after arriving (workflow 07) */
  noShowAfterSeconds: number;
  /** rider cancels free within this window after matching */
  freeCancelSeconds: number;
  cancellationFeeMinor: number;
  /** share of the fee credited to the beneficiary */
  driverCompensationShare: number;
  /** completing farther than this from the drop-off is flagged for review (workflow 06 §7) */
  completeFarFromDropoffMeters: number;
}

export const DEFAULT_POLICY: CityPolicy = {
  arrivalRadiusMeters: 150,
  freeWaitingSeconds: 180,
  noShowAfterSeconds: 300,
  freeCancelSeconds: 120,
  cancellationFeeMinor: 3000, // 30 ETB
  driverCompensationShare: 0.8,
  completeFarFromDropoffMeters: 300,
};

/** The rules in force in a city right now. */
export const policyFor = (settings: SettingsReader, cityId: string): CityPolicy => ({
  arrivalRadiusMeters: settings.get<number>("trip.arrivalRadiusMeters", cityId),
  freeWaitingSeconds: settings.get<number>("trip.freeWaitingSeconds", cityId),
  noShowAfterSeconds: settings.get<number>("trip.noShowAfterSeconds", cityId),
  freeCancelSeconds: settings.get<number>("cancel.freeSeconds", cityId),
  cancellationFeeMinor: settings.get<number>("cancel.feeMinor", cityId),
  driverCompensationShare: settings.get<number>("cancel.driverShare", cityId),
  completeFarFromDropoffMeters: settings.get<number>("trip.completeFarFromDropoffMeters", cityId),
});

/** Paid waiting after the free minutes, per started minute (workflow 06 step 7). */
export function waitingFee(p: CityPolicy, arrivedAt: Date | null, until: Date, perMinuteMinor: bigint): bigint {
  if (!arrivedAt) return 0n;
  const paidSeconds = (until.getTime() - arrivedAt.getTime()) / 1000 - p.freeWaitingSeconds;
  return paidSeconds > 0 ? BigInt(Math.ceil(paidSeconds / 60)) * perMinuteMinor : 0n;
}

export type CancelledBy = "RIDER" | "DRIVER" | "SYSTEM" | "STAFF";

export interface CancelInput {
  by: CancelledBy;
  reason: string;
  status: string;
  matchedAt: Date | null;
  arrivedAt: Date | null;
  waitingPerMinMinor: bigint;
  now: Date;
}

/** Workflow 07 §3: who pays what. Staff and system cancellations are free by default. */
export function cancellationFee(p: CityPolicy, c: CancelInput): { feeMinor: bigint; compensationMinor: bigint; waived?: string } {
  const none = (waived?: string) => ({ feeMinor: 0n, compensationMinor: 0n, ...(waived ? { waived } : {}) });
  const charge = (extra = 0n) => {
    const fee = BigInt(p.cancellationFeeMinor) + extra;
    return { feeMinor: fee, compensationMinor: (fee * BigInt(Math.round(p.driverCompensationShare * 100))) / 100n };
  };

  if (c.by === "SYSTEM" || c.by === "STAFF") return none();
  if (c.by === "DRIVER") return c.reason === "NO_SHOW" ? charge() : none();

  // rider
  if (c.status === "requested" || !c.matchedAt) return none();
  if (c.reason === "DRIVER_ASKED_TO_CANCEL") return none("driver_asked");
  if (c.arrivedAt) return charge(waitingFee(p, c.arrivedAt, c.now, c.waitingPerMinMinor));
  if (c.now.getTime() - c.matchedAt.getTime() <= p.freeCancelSeconds * 1000) return none("free_window");
  return charge();
}
