// Corporate ride policies (workflow 11, step 4 and steps 9–10). A company admin
// (corporate:manage_policies @ ORG) sets what trips billed to the company may be; every trip
// billed to it is checked when it is requested or scheduled. A violated rule is a 422 naming the
// rule, so the employee can switch to personal payment.
//
// Times are Addis Ababa local (UTC+3, no daylight saving). The monthly budget is per company:
// trips billed to it in the calendar month (not cancelled; the final fare once completed, else the
// estimate) plus rides scheduled for that month that haven't been dispatched yet.

import { authorize, type Principal } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import type { CorporatePolicy } from "../generated/prisma/client.js";
import { AppError, badRequest } from "../lib/errors.js";
import { audit, writeOutbox } from "../outbox/outbox.js";

const ADDIS_OFFSET_MS = 3 * 3600_000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface PolicyInput {
  allowedVehicleTypes: string[];
  allowedDays: number[];
  startMinute: number | null;
  endMinute: number | null;
  maxFareMinor: number | null;
  monthlyBudgetMinor: number | null;
  requirePurpose: boolean;
}

export type PolicyRule = "vehicle_type" | "day" | "hours" | "max_fare" | "monthly_budget" | "purpose";

export class PolicyViolation extends AppError {
  constructor(readonly rule: PolicyRule, message: string) {
    super(422, message, "policy_violation");
  }
}

const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const etb = (minor: bigint | number) => `${(Number(minor) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} ETB`;

/** Addis local day of week and minute of day of an instant. */
export function addisClock(at: Date): { day: number; minute: number; month: string } {
  const local = new Date(at.getTime() + ADDIS_OFFSET_MS);
  return { day: local.getUTCDay(), minute: local.getUTCHours() * 60 + local.getUTCMinutes(), month: local.toISOString().slice(0, 7) };
}

/** [start, end) of the Addis calendar month containing `at`. */
export function addisMonth(at: Date): { from: Date; to: Date } {
  const local = new Date(at.getTime() + ADDIS_OFFSET_MS);
  const from = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - ADDIS_OFFSET_MS;
  const to = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - ADDIS_OFFSET_MS;
  return { from: new Date(from), to: new Date(to) };
}

/** Inside the allowed hours? start > end wraps past midnight (e.g. 22:00–06:00). */
export function withinHours(minute: number, start: number, end: number): boolean {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function policyView(p: CorporatePolicy | null, orgId: string) {
  return {
    orgId,
    allowedVehicleTypes: p?.allowedVehicleTypes ?? [],
    allowedDays: p?.allowedDays ?? [],
    startMinute: p?.startMinute ?? null,
    endMinute: p?.endMinute ?? null,
    maxFareMinor: p?.maxFareMinor === null || p?.maxFareMinor === undefined ? null : Number(p.maxFareMinor),
    monthlyBudgetMinor: p?.monthlyBudgetMinor === null || p?.monthlyBudgetMinor === undefined ? null : Number(p.monthlyBudgetMinor),
    requirePurpose: p?.requirePurpose ?? false,
    updatedAt: p?.updatedAt ?? null,
    updatedByUserId: p?.updatedByUserId ?? null,
    /** false until an admin saves a policy (then every rule is "no limit") */
    configured: !!p,
  };
}

export function createCorporatePolicies(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** What the company has spent (and committed by scheduled rides) in the Addis month of `at`. */
  async function monthSpend(orgId: string, at: Date): Promise<bigint> {
    const { from, to } = addisMonth(at);
    const [trips] = await db.$queryRaw<{ total: bigint | null }[]>`
      SELECT sum(coalesce(fare_final_minor, fare_estimate_minor))::bigint AS total FROM trip
      WHERE billing_org_id = ${orgId}::uuid AND created_at >= ${from} AND created_at < ${to} AND status <> 'cancelled'`;
    const [scheduled] = await db.$queryRaw<{ total: bigint | null }[]>`
      SELECT sum(fare_estimate_minor)::bigint AS total FROM scheduled_trip
      WHERE billing_org_id = ${orgId}::uuid AND scheduled_for >= ${from} AND scheduled_for < ${to} AND status IN ('SCHEDULED','DISPATCHING')`;
    return (trips?.total ?? 0n) + (scheduled?.total ?? 0n);
  }

  return {
    async get(p: Principal, orgId: string) {
      // admins edit it; anyone who may book on the account may read the rules they book under
      authorize(p, p.audience === "ride-admin" ? "trip:read" : "trip:bill_corporate", { orgId });
      const row = await db.corporatePolicy.findUnique({ where: { orgId } });
      const view = policyView(row, orgId);
      const spent = await monthSpend(orgId, now());
      return { ...view, month: addisClock(now()).month, spentThisMonthMinor: Number(spent) };
    },

    async put(p: Principal, orgId: string, input: PolicyInput) {
      authorize(p, "corporate:manage_policies", { orgId });
      if ((input.startMinute === null) !== (input.endMinute === null)) throw badRequest("set both startMinute and endMinute, or neither");
      if (input.startMinute !== null && input.startMinute === input.endMinute) throw badRequest("the allowed hours can't start and end at the same time");
      const data = {
        allowedVehicleTypes: [...new Set(input.allowedVehicleTypes)],
        allowedDays: [...new Set(input.allowedDays)].sort(),
        startMinute: input.startMinute, endMinute: input.endMinute,
        maxFareMinor: input.maxFareMinor === null ? null : BigInt(input.maxFareMinor),
        monthlyBudgetMinor: input.monthlyBudgetMinor === null ? null : BigInt(input.monthlyBudgetMinor),
        requirePurpose: input.requirePurpose, updatedByUserId: p.userId,
      };
      const row = await db.$transaction(async (tx) => {
        const saved = await tx.corporatePolicy.upsert({
          where: { orgId },
          create: { orgId, ...data },
          update: { ...data, version: { increment: 1 } },
        });
        await writeOutbox(tx, {
          topic: "corporate.policy_updated",
          payload: { orgId, byUserId: p.userId, ...data, maxFareMinor: input.maxFareMinor, monthlyBudgetMinor: input.monthlyBudgetMinor },
        });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "corporate:manage_policies", resource: { type: "corporate_policy", id: orgId }, outcome: "EXECUTED" }));
        return saved;
      });
      return policyView(row, orgId);
    },

    /**
     * Throws PolicyViolation (422) when a trip billed to `orgId` breaks its policy. `at` is when the
     * ride happens (now, or the scheduled pickup). `ignoreScheduledId` leaves a booking being edited
     * out of the budget.
     */
    async check(orgId: string, trip: { vehicleType: string; fareMinor: number | bigint; at: Date; purpose?: string | null; ignoreScheduledFareMinor?: bigint }) {
      const policy = await db.corporatePolicy.findUnique({ where: { orgId } });
      if (!policy) return;
      if (policy.allowedVehicleTypes.length && !policy.allowedVehicleTypes.includes(trip.vehicleType)) {
        throw new PolicyViolation("vehicle_type", `Your company allows ${policy.allowedVehicleTypes.join(", ")} rides only`);
      }
      const { day, minute } = addisClock(trip.at);
      if (policy.allowedDays.length && !policy.allowedDays.includes(day)) {
        throw new PolicyViolation("day", `Your company allows rides on ${policy.allowedDays.map((d) => DAY_NAMES[d]).join(", ")} only`);
      }
      if (policy.startMinute !== null && policy.endMinute !== null && !withinHours(minute, policy.startMinute, policy.endMinute)) {
        throw new PolicyViolation("hours", `Your company allows rides ${hhmm(policy.startMinute)}–${hhmm(policy.endMinute)} only`);
      }
      const fare = BigInt(trip.fareMinor);
      if (policy.maxFareMinor !== null && fare > policy.maxFareMinor) {
        throw new PolicyViolation("max_fare", `Your company allows rides up to ${etb(policy.maxFareMinor)} (this one is about ${etb(fare)})`);
      }
      if (policy.requirePurpose && !trip.purpose?.trim()) {
        throw new PolicyViolation("purpose", "Your company asks for a trip purpose or cost centre");
      }
      if (policy.monthlyBudgetMinor !== null) {
        const spent = (await monthSpend(orgId, trip.at)) - (trip.ignoreScheduledFareMinor ?? 0n);
        if (spent + fare > policy.monthlyBudgetMinor) {
          throw new PolicyViolation("monthly_budget", `This ride would go over your company's monthly ride budget of ${etb(policy.monthlyBudgetMinor)}`);
        }
      }
    },
  };
}

export type CorporatePolicies = ReturnType<typeof createCorporatePolicies>;
