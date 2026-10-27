// What a driver made over a period (GET /api/payments/earnings/me): sums over their trip
// settlements, by Addis day. Drivers see their own; fleet owners read the fleet's balance pages
// instead (settlements there are per beneficiary, not per driver).

import { authorize, type Principal } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { badRequest } from "../lib/errors.js";

/** Africa/Addis_Ababa has no daylight saving: a fixed +3 h. */
const ADDIS_OFFSET_MS = 3 * 3600_000;
const DAY_MS = 86_400_000;
const MAX_CUSTOM_DAYS = 92;

export type EarningsPeriod = "today" | "week" | "month" | "custom";

export interface EarningsSummary {
  from: string;
  to: string;
  trips: number;
  cancellations: number;
  grossMinor: number;
  commissionMinor: number;
  vatMinor: number;
  /** what the driver made: fare − commission − VAT on trips, plus cancellation compensation */
  netMinor: number;
  /** how the balance moved: on cash trips the driver keeps the fare and owes commission + VAT */
  balanceChangeMinor: number;
  cashCollectedMinor: number;
  byDay: { day: string; trips: number; grossMinor: number; netMinor: number }[];
}

/** Midnight (Addis) of the day containing `t`, as a UTC Date. */
function addisDayStart(t: Date): Date {
  const local = t.getTime() + ADDIS_OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - ADDIS_OFFSET_MS);
}

/** YYYY-MM-DD in Addis time. */
function addisDay(t: Date): string {
  return new Date(t.getTime() + ADDIS_OFFSET_MS).toISOString().slice(0, 10);
}

export function periodRange(period: EarningsPeriod, now: Date, custom?: { from?: string; to?: string }): { from: Date; to: Date } {
  const todayStart = addisDayStart(now);
  switch (period) {
    case "today":
      return { from: todayStart, to: new Date(todayStart.getTime() + DAY_MS) };
    case "week": {
      // Monday to Sunday, Addis
      const dow = (new Date(todayStart.getTime() + ADDIS_OFFSET_MS).getUTCDay() + 6) % 7; // Monday = 0
      const from = new Date(todayStart.getTime() - dow * DAY_MS);
      return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
    }
    case "month": {
      const local = new Date(todayStart.getTime() + ADDIS_OFFSET_MS);
      const from = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - ADDIS_OFFSET_MS);
      const to = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - ADDIS_OFFSET_MS);
      return { from, to };
    }
    case "custom": {
      const day = /^\d{4}-\d{2}-\d{2}$/;
      if (!custom?.from || !custom.to || !day.test(custom.from) || !day.test(custom.to)) throw badRequest("from and to must be YYYY-MM-DD", "invalid_range");
      const from = new Date(Date.parse(`${custom.from}T00:00:00.000Z`) - ADDIS_OFFSET_MS);
      const to = new Date(Date.parse(`${custom.to}T00:00:00.000Z`) - ADDIS_OFFSET_MS + DAY_MS);
      if (!(to > from) || (to.getTime() - from.getTime()) / DAY_MS > MAX_CUSTOM_DAYS) throw badRequest(`a range of 1–${MAX_CUSTOM_DAYS} days`, "invalid_range");
      return { from, to };
    }
  }
}

export function createEarnings(deps: { db: Db; now: () => Date }) {
  const { db } = deps;
  return {
    async mine(p: Principal, period: EarningsPeriod, custom?: { from?: string; to?: string }): Promise<EarningsSummary> {
      authorize(p, "earnings:read", { ownerUserIds: [p.userId] });
      const { from, to } = periodRange(period, deps.now(), custom);
      const rows = await db.tripSettlement.findMany({
        where: { driverId: p.userId, settledAt: { gte: from, lt: to } },
        select: { purpose: true, paymentMethod: true, fareMinor: true, commissionMinor: true, vatMinor: true, earningsMinor: true, settledAt: true },
        orderBy: { settledAt: "asc" },
      });
      const out: EarningsSummary = { from: from.toISOString(), to: to.toISOString(), trips: 0, cancellations: 0, grossMinor: 0, commissionMinor: 0, vatMinor: 0, netMinor: 0, balanceChangeMinor: 0, cashCollectedMinor: 0, byDay: [] };
      const days = new Map<string, { trips: number; grossMinor: number; netMinor: number }>();
      for (const r of rows) {
        const fare = Number(r.fareMinor);
        const balanceChange = Number(r.earningsMinor);
        // a cash trip's settlement records the debt (−commission −VAT), not what the driver made
        const net = r.purpose === "TRIP_FARE" ? fare - Number(r.commissionMinor) - Number(r.vatMinor) : balanceChange;
        const day = days.get(addisDay(r.settledAt)) ?? { trips: 0, grossMinor: 0, netMinor: 0 };
        if (r.purpose === "TRIP_FARE") {
          out.trips++;
          out.grossMinor += fare;
          if (r.paymentMethod === "CASH") out.cashCollectedMinor += fare;
          day.trips++;
          day.grossMinor += fare;
        } else {
          out.cancellations++;
        }
        out.commissionMinor += Number(r.commissionMinor);
        out.vatMinor += Number(r.vatMinor);
        out.netMinor += net;
        out.balanceChangeMinor += balanceChange;
        day.netMinor += net;
        days.set(addisDay(r.settledAt), day);
      }
      out.byDay = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v }));
      return out;
    },
  };
}

export type EarningsService = ReturnType<typeof createEarnings>;
