// A company's corporate charges (GET /api/payments/org/:orgId/payments) and finance's daily
// report (GET /api/payments/reports/daily[.csv]). Both are SQL reads over the ledger and the
// money tables; days are Addis Ababa days (UTC+3), indexes from 20261031100000_report_indexes.

import { authorize, AuthorizationError, can, type Principal } from "@ride-app/shared-authz";
import { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { accounts } from "../ledger/ledger.js";
import { addisDay } from "./earnings.js";

const DAY_MS = 86_400_000;
const ADDIS_OFFSET_MS = 3 * 3600_000;
const MAX_DAYS = 92;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive Addis days → [from, to). Defaults: the last 7 days up to today. */
export function reportRange(q: { from?: string; to?: string }, now: Date) {
  for (const v of [q.from, q.to]) {
    if (v !== undefined && (!DAY_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw badRequest("from and to must be YYYY-MM-DD", "invalid_range");
  }
  const toDay = q.to ?? addisDay(now);
  const start = (d: string) => new Date(Date.parse(`${d}T00:00:00.000Z`) - ADDIS_OFFSET_MS);
  const fromDay = q.from ?? addisDay(new Date(start(toDay).getTime() - 6 * DAY_MS + ADDIS_OFFSET_MS));
  const from = start(fromDay);
  const to = new Date(start(toDay).getTime() + DAY_MS);
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days < 1 || days > MAX_DAYS) throw badRequest(`a range of 1–${MAX_DAYS} days`, "invalid_range");
  return { from, to, fromDay, toDay };
}

/** `<microseconds since epoch>_<uuid>` (Postgres keeps microseconds; a JS Date doesn't). */
function parseCursor(raw?: string) {
  if (!raw) return undefined;
  const m = /^(\d{1,17})_([0-9a-f-]{36})$/i.exec(raw);
  if (!m) throw badRequest("before must be the `next` value of a previous page", "invalid_cursor");
  return { us: m[1]!, id: m[2]!.toLowerCase() };
}

type Sum = { count: number; amountMinor: number };
type MethodSum = { trips: number; fareMinor: number; commissionMinor: number; vatMinor: number };

export interface FinanceDay {
  date: string;
  /** completed trips settled that day */
  trips: number;
  fareMinor: number;
  commissionMinor: number;
  vatMinor: number;
  /** what beneficiaries' balances moved by (trips and fee compensation) */
  earningsMinor: number;
  byMethod: Record<string, MethodSum>;
  cancellationFees: { count: number; feeMinor: number; commissionMinor: number };
  /** rider payments captured by a provider, by the day they succeeded */
  collections: Record<string, Sum>;
  refunds: Sum;
  payouts: Sum;
  topUps: Record<string, Sum>;
}
export interface FinanceDailyReport {
  cityId: string | null;
  from: string;
  to: string;
  days: FinanceDay[];
  totals: Omit<FinanceDay, "date">;
}

const emptyDay = (date: string): FinanceDay => ({
  date, trips: 0, fareMinor: 0, commissionMinor: 0, vatMinor: 0, earningsMinor: 0, byMethod: {},
  cancellationFees: { count: 0, feeMinor: 0, commissionMinor: 0 }, collections: {}, refunds: { count: 0, amountMinor: 0 }, payouts: { count: 0, amountMinor: 0 }, topUps: {},
});

function addSum(into: Record<string, Sum>, k: string, v: Sum) {
  const s = (into[k] ??= { count: 0, amountMinor: 0 });
  s.count += v.count;
  s.amountMinor += v.amountMinor;
}

function totalsOf(days: FinanceDay[]): Omit<FinanceDay, "date"> {
  const t = emptyDay("");
  for (const d of days) {
    t.trips += d.trips;
    t.fareMinor += d.fareMinor;
    t.commissionMinor += d.commissionMinor;
    t.vatMinor += d.vatMinor;
    t.earningsMinor += d.earningsMinor;
    for (const [k, v] of Object.entries(d.byMethod)) {
      const m = (t.byMethod[k] ??= { trips: 0, fareMinor: 0, commissionMinor: 0, vatMinor: 0 });
      m.trips += v.trips;
      m.fareMinor += v.fareMinor;
      m.commissionMinor += v.commissionMinor;
      m.vatMinor += v.vatMinor;
    }
    t.cancellationFees.count += d.cancellationFees.count;
    t.cancellationFees.feeMinor += d.cancellationFees.feeMinor;
    t.cancellationFees.commissionMinor += d.cancellationFees.commissionMinor;
    for (const [k, v] of Object.entries(d.collections)) addSum(t.collections, k, v);
    for (const [k, v] of Object.entries(d.topUps)) addSum(t.topUps, k, v);
    t.refunds.count += d.refunds.count;
    t.refunds.amountMinor += d.refunds.amountMinor;
    t.payouts.count += d.payouts.count;
    t.payouts.amountMinor += d.payouts.amountMinor;
  }
  const { date: _date, ...rest } = t;
  return rest;
}

const day = (col: Prisma.Sql) => Prisma.sql`to_char(${col} AT TIME ZONE 'Africa/Addis_Ababa', 'YYYY-MM-DD')`;
const n = (v: bigint | number | null) => Number(v ?? 0);

export function createReports(deps: { db: Db; now: () => Date }) {
  const { db } = deps;

  return {
    /**
     * What a company was charged for corporate-billed trips and fees: the postings on its
     * CORPORATE_RECEIVABLE account, newest first. payment:read @ ORG (company account admins)
     * or report:read_finance; anyone else 403.
     */
    async orgCharges(p: Principal, orgId: string, q: { before?: string; limit: number }) {
      if (!can(p, "payment:read", { orgId }) && !can(p, "report:read_finance")) throw new AuthorizationError("payment:read");
      const cursor = parseCursor(q.before);
      const account = await db.ledgerAccount.findUnique({ where: { code: accounts.corporate(orgId).code } });
      if (!account) return { orgId, owedMinor: 0, charges: [], next: null };
      const rows = await db.$queryRaw<{
        id: string; us: bigint; at: Date; amount: bigint; kind: string; memo: string | null; ref_type: string; ref_id: string;
        purpose: string | null; rider_id: string | null; city_id: string | null; vehicle_type: string | null;
      }[]>`
        SELECT p.id::text AS id, (extract(epoch FROM p.created_at) * 1000000)::bigint AS us, p.created_at AS at, p.amount_minor AS amount,
          je.kind, je.memo, je.reference_type AS ref_type, je.reference_id AS ref_id,
          ts.purpose, ts.rider_id::text AS rider_id, ts.city_id, ts.vehicle_type
        FROM posting p
        JOIN journal_entry je ON je.id = p.journal_entry_id
        LEFT JOIN trip_settlement ts
          ON ts.trip_id = (CASE WHEN je.reference_type = 'trip' THEN je.reference_id::uuid END)
          AND ts.purpose = (CASE je.kind WHEN 'TRIP_SETTLEMENT' THEN 'TRIP_FARE' WHEN 'CANCELLATION_FEE' THEN 'CANCELLATION_FEE' END)
        WHERE p.account_id = ${account.id}::uuid
          ${cursor ? Prisma.sql`AND (p.created_at, p.id) < (timestamptz 'epoch' + ${cursor.us}::bigint * interval '1 microsecond', ${cursor.id}::uuid)` : Prisma.empty}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${q.limit}`;
      const last = rows.at(-1);
      return {
        orgId,
        // the receivable is negative while the company owes
        owedMinor: -Number(account.balanceMinor),
        charges: rows.map((r) => ({
          id: r.id, at: r.at.toISOString(), kind: r.kind, memo: r.memo,
          tripId: r.ref_type === "trip" ? r.ref_id : null, purpose: r.purpose,
          amountMinor: -Number(r.amount), riderId: r.rider_id, cityId: r.city_id, vehicleType: r.vehicle_type,
        })),
        next: last && rows.length === q.limit ? `${last.us}_${last.id}` : null,
      };
    },

    /** Money per Addis day (report:read_finance; everywhere, or one city). */
    async daily(p: Principal, cityId: string | undefined, q: { from?: string; to?: string }): Promise<FinanceDailyReport> {
      authorize(p, "report:read_finance", cityId ? { cityId } : {});
      const { from, to, fromDay, toDay } = reportRange(q, deps.now());
      const city = (col: string) => (cityId ? Prisma.sql`AND ${Prisma.raw(col)} = ${cityId}` : Prisma.empty);

      const [settled, collected, refunds, payouts, topUps] = await Promise.all([
        db.$queryRaw<{ day: string; purpose: string; method: string; n: bigint; fare: bigint; commission: bigint; vat: bigint; earnings: bigint }[]>`
          SELECT ${day(Prisma.sql`settled_at`)} AS day, purpose, payment_method AS method, count(*) AS n,
            sum(fare_minor)::bigint AS fare, sum(commission_minor)::bigint AS commission, sum(vat_minor)::bigint AS vat, sum(earnings_minor)::bigint AS earnings
          FROM trip_settlement WHERE settled_at >= ${from} AND settled_at < ${to} ${city("city_id")}
          GROUP BY 1, 2, 3`,
        db.$queryRaw<{ day: string; method: string; n: bigint; amount: bigint }[]>`
          SELECT ${day(Prisma.sql`completed_at`)} AS day, method, count(*) AS n, sum(amount_minor)::bigint AS amount
          FROM payment WHERE completed_at >= ${from} AND completed_at < ${to} AND status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED') ${city("city_id")}
          GROUP BY 1, 2`,
        db.$queryRaw<{ day: string; n: bigint; amount: bigint }[]>`
          SELECT ${day(Prisma.sql`r.completed_at`)} AS day, count(*) AS n, sum(r.amount_minor)::bigint AS amount
          FROM refund r JOIN payment p ON p.id = r.payment_id
          WHERE r.status = 'SUCCEEDED' AND r.completed_at >= ${from} AND r.completed_at < ${to} ${city("p.city_id")}
          GROUP BY 1`,
        db.$queryRaw<{ day: string; n: bigint; amount: bigint }[]>`
          SELECT ${day(Prisma.sql`l.updated_at`)} AS day, count(*) AS n, sum(l.amount_minor)::bigint AS amount
          FROM payout_line l JOIN beneficiary b ON b.account_id = l.beneficiary_account_id
          WHERE l.status = 'SUCCEEDED' AND l.updated_at >= ${from} AND l.updated_at < ${to} ${city("b.city_id")}
          GROUP BY 1`,
        db.$queryRaw<{ day: string; channel: string; n: bigint; amount: bigint }[]>`
          SELECT ${day(Prisma.sql`t.completed_at`)} AS day, t.channel, count(*) AS n, sum(t.amount_minor)::bigint AS amount
          FROM top_up t JOIN beneficiary b ON b.account_id = t.beneficiary_account_id
          WHERE t.status = 'SUCCEEDED' AND t.completed_at >= ${from} AND t.completed_at < ${to} ${city("b.city_id")}
          GROUP BY 1, 2`,
      ]);

      const days = new Map<string, FinanceDay>();
      for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) days.set(addisDay(new Date(t)), emptyDay(addisDay(new Date(t))));
      const at = (d: string) => days.get(d) ?? days.set(d, emptyDay(d)).get(d)!;
      for (const r of settled) {
        const d = at(r.day);
        d.earningsMinor += n(r.earnings);
        if (r.purpose === "TRIP_FARE") {
          d.trips += n(r.n);
          d.fareMinor += n(r.fare);
          d.commissionMinor += n(r.commission);
          d.vatMinor += n(r.vat);
          const m = (d.byMethod[r.method] ??= { trips: 0, fareMinor: 0, commissionMinor: 0, vatMinor: 0 });
          m.trips += n(r.n);
          m.fareMinor += n(r.fare);
          m.commissionMinor += n(r.commission);
          m.vatMinor += n(r.vat);
        } else {
          d.cancellationFees.count += n(r.n);
          d.cancellationFees.feeMinor += n(r.fare);
          d.cancellationFees.commissionMinor += n(r.commission);
          d.commissionMinor += n(r.commission);
        }
      }
      for (const r of collected) addSum(at(r.day).collections, r.method, { count: n(r.n), amountMinor: n(r.amount) });
      for (const r of topUps) addSum(at(r.day).topUps, r.channel, { count: n(r.n), amountMinor: n(r.amount) });
      for (const r of refunds) at(r.day).refunds = { count: n(r.n), amountMinor: n(r.amount) };
      for (const r of payouts) at(r.day).payouts = { count: n(r.n), amountMinor: n(r.amount) };
      const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
      return { cityId: cityId ?? null, from: fromDay, to: toDay, days: list, totals: totalsOf(list) };
    },
  };
}

export type ReportsService = ReturnType<typeof createReports>;

// ── CSV ──────────────────────────────────────────────────────────────────────

const METHODS = ["CASH", "MOBILE_MONEY", "CARD", "CORPORATE"];
const COLLECTED = ["MOBILE_MONEY", "CARD"];
const CHANNELS = ["MOBILE_MONEY", "OFFICE_CASH", "BANK_TRANSFER"];

/** One row per day plus a `total` row. */
export function financeReportCsv(r: FinanceDailyReport): string {
  const methods = [...new Set([...METHODS, ...Object.keys(r.totals.byMethod)])];
  const collected = [...new Set([...COLLECTED, ...Object.keys(r.totals.collections)])];
  const channels = [...new Set([...CHANNELS, ...Object.keys(r.totals.topUps)])];
  const header = [
    "date", "trips", "fare_minor", "commission_minor", "vat_minor", "earnings_minor",
    ...methods.flatMap((m) => [`${m.toLowerCase()}_trips`, `${m.toLowerCase()}_fare_minor`, `${m.toLowerCase()}_commission_minor`]),
    "cancellation_fees", "cancellation_fee_minor", "cancellation_commission_minor",
    ...collected.flatMap((m) => [`collected_${m.toLowerCase()}_count`, `collected_${m.toLowerCase()}_minor`]),
    "refunds", "refund_minor", "payouts", "payout_minor",
    ...channels.flatMap((c) => [`topup_${c.toLowerCase()}_count`, `topup_${c.toLowerCase()}_minor`]),
  ];
  const row = (date: string, d: Omit<FinanceDay, "date">) => [
    date, d.trips, d.fareMinor, d.commissionMinor, d.vatMinor, d.earningsMinor,
    ...methods.flatMap((m) => [d.byMethod[m]?.trips ?? 0, d.byMethod[m]?.fareMinor ?? 0, d.byMethod[m]?.commissionMinor ?? 0]),
    d.cancellationFees.count, d.cancellationFees.feeMinor, d.cancellationFees.commissionMinor,
    ...collected.flatMap((m) => [d.collections[m]?.count ?? 0, d.collections[m]?.amountMinor ?? 0]),
    d.refunds.count, d.refunds.amountMinor, d.payouts.count, d.payouts.amountMinor,
    ...channels.flatMap((c) => [d.topUps[c]?.count ?? 0, d.topUps[c]?.amountMinor ?? 0]),
  ].join(",");
  return [header.join(","), ...r.days.map((d) => row(d.date, d)), row("total", r.totals)].join("\r\n") + "\r\n";
}
