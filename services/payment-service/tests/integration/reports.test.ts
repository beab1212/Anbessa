import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TripCancelledEvent } from "@ride-app/shared-types";
import { createHarness, uuid, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

// Default rule and policy: 15% commission (at least 10 ETB), VAT 15% of the commission.
// A 400 ETB fare: commission 60, VAT 9; the driver makes 331 ETB.

/** A city of its own per test, so rows from other tests never count. */
const freshCity = () => `t-${uuid().slice(0, 8)}`;

describe("a fleet's earnings", () => {
  it("adds up the settlements of the fleet's cars, per day and per driver", async () => {
    const fleet = uuid();
    const [d1, d2] = [uuid(), uuid()];
    await h.c.payments.onTripCompleted(h.completed({ driverId: d1, fleetOrgId: fleet, fareMinor: 40_000 })); // cash
    await h.c.payments.onTripCompleted(h.completed({ driverId: d2, fleetOrgId: fleet, fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: uuid() }));
    await h.c.payments.onTripCompleted(h.completed({ driverId: d1, fareMinor: 40_000 })); // d1's own car: not the fleet's

    const owner = await h.person([{ r: "FLEET_OWNER", org: fleet }]);
    const s = await h.ok<Record<string, unknown> & { byDriver: { driverId: string; trips: number; netMinor: number }[]; byDay: unknown[] }>(
      h.req("GET", `/api/payments/earnings/org/${fleet}?period=today`, owner));
    // the cash trip's net is what the driver made (fare − commission − VAT), not the balance debt
    expect(s).toMatchObject({ orgId: fleet, trips: 2, grossMinor: 80_000, commissionMinor: 12_000, vatMinor: 1800, netMinor: 66_200, balanceChangeMinor: 26_200, cashCollectedMinor: 40_000 });
    expect(s.byDay).toHaveLength(1);
    expect(s.byDriver.map((x) => x.driverId).sort()).toEqual([d1, d2].sort());
    for (const x of s.byDriver) expect(x).toMatchObject({ trips: 1, netMinor: 33_100 });
    expect((await h.req("GET", `/api/payments/earnings/org/${fleet}?period=custom&from=2020-01-01&to=2020-01-02`, owner)).json()).toMatchObject({ trips: 0, byDriver: [] });
    expect((await h.req("GET", `/api/payments/earnings/org/${fleet}?period=custom&from=2020-01-01&to=2020-12-31`, owner)).json()).toMatchObject({ error: "invalid_range" });

    // finance reads any fleet; a fleet that never earned shows zeros
    const finance = await h.financeOfficer();
    expect(await h.ok(h.req("GET", `/api/payments/earnings/org/${fleet}?period=week`, finance))).toMatchObject({ trips: 2 });
    expect(await h.ok(h.req("GET", `/api/payments/earnings/org/${uuid()}`, finance))).toMatchObject({ trips: 0, netMinor: 0 });
  });

  it("only the fleet's owner (or finance) may read it", async () => {
    const fleet = uuid();
    const url = `/api/payments/earnings/org/${fleet}`;
    expect((await h.req("GET", url, await h.person([{ r: "FLEET_OWNER", org: uuid() }]))).statusCode).toBe(403);
    expect((await h.req("GET", url, await h.person([{ r: "FLEET_DRIVER", org: fleet }]))).statusCode).toBe(403);
    expect((await h.req("GET", url, await h.person([{ r: "CORPORATE_ADMIN", org: fleet }]))).statusCode).toBe(403);
    expect((await h.req("GET", url, await h.driver())).statusCode).toBe(403);
    expect((await h.req("GET", url, await h.staff([{ r: "SUPPORT_AGENT", city: "addis-ababa" }]))).statusCode).toBe(403);
    expect((await h.req("GET", "/api/payments/earnings/org/not-a-uuid", await h.financeOfficer())).statusCode).toBe(400);
  });
});

describe("a company's corporate charges", () => {
  it("lists what corporate trips and fees cost the company, newest first, with what it owes", async () => {
    const org = uuid();
    const rider = uuid();
    const t1 = h.completed({ driverId: uuid(), fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: org, riderId: rider });
    await h.c.payments.onTripCompleted(t1);
    const t2 = h.completed({ driverId: uuid(), fareMinor: 25_000, paymentMethod: "CORPORATE", billingOrgId: org });
    await h.c.payments.onTripCompleted(t2);
    const fee: TripCancelledEvent & { billingOrgId: string } = { ...h.cancelled({ driverId: uuid(), feeMinor: 3000, compensationMinor: 2400 }), paymentMethod: "CORPORATE", billingOrgId: org };
    await h.c.payments.onTripCancelled(fee);
    await h.c.payments.onTripCompleted(h.completed({ driverId: uuid(), fareMinor: 10_000, paymentMethod: "CORPORATE", billingOrgId: uuid() })); // another company

    const admin = await h.person([{ r: "CORPORATE_ADMIN", org }]);
    type Page = { owedMinor: number; charges: { id: string; tripId: string; purpose: string; amountMinor: number; riderId: string; kind: string; vehicleType: string | null }[]; next: string | null };
    const first = await h.ok<Page>(h.req("GET", `/api/payments/org/${org}/payments`, admin));
    expect(first.owedMinor).toBe(68_000);
    expect(first.next).toBeNull();
    expect(first.charges.map((c) => [c.tripId, c.purpose, c.amountMinor])).toEqual([
      [fee.tripId, "CANCELLATION_FEE", 3000], [t2.tripId, "TRIP_FARE", 25_000], [t1.tripId, "TRIP_FARE", 40_000],
    ]);
    expect(first.charges[2]).toMatchObject({ riderId: rider, kind: "TRIP_SETTLEMENT", vehicleType: "economy" });

    // keyset paging, one at a time
    const seen: string[] = [];
    let next: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page: Page = await h.ok<Page>(h.req("GET", `/api/payments/org/${org}/payments?limit=1${next ? `&before=${next}` : ""}`, admin));
      seen.push(...page.charges.map((c) => c.id));
      next = page.next;
      if (!next) break;
    }
    expect(seen).toEqual(first.charges.map((c) => c.id));
    expect((await h.req("GET", `/api/payments/org/${org}/payments?before=yesterday`, admin)).json()).toMatchObject({ error: "invalid_cursor" });

    // a company that was never billed owes nothing
    const fresh = uuid();
    expect(await h.ok(h.req("GET", `/api/payments/org/${fresh}/payments`, await h.person([{ r: "CORPORATE_ADMIN", org: fresh }])))).toMatchObject({ owedMinor: 0, charges: [], next: null });
    // finance reads any company
    expect(await h.ok<Page>(h.req("GET", `/api/payments/org/${org}/payments`, await h.financeManager()))).toMatchObject({ owedMinor: 68_000 });
  });

  it("only the company's account admin (or finance) may read them", async () => {
    const org = uuid();
    const url = `/api/payments/org/${org}/payments`;
    expect((await h.req("GET", url, await h.person([{ r: "CORPORATE_ADMIN", org: uuid() }]))).statusCode).toBe(403);
    expect((await h.req("GET", url, await h.person([{ r: "CORPORATE_COORDINATOR", org }]))).statusCode).toBe(403);
    expect((await h.req("GET", url, await h.person([{ r: "CORPORATE_EMPLOYEE", org }]))).statusCode).toBe(403);
    expect((await h.req("GET", url, await h.person())).statusCode).toBe(403);
    expect((await h.req("GET", url, await h.staff([{ r: "SUPPORT_AGENT", city: "addis-ababa" }]))).statusCode).toBe(403);
  });
});

describe("the finance daily report", () => {
  it("sums settlements by method, fees, collections, refunds, payouts and top-ups per Addis day", async () => {
    const city = freshCity();
    const saved = h.clock.now;
    // 12:00 in Addis on 2026-09-15
    h.clock.now = Date.parse("2026-09-15T09:00:00Z");
    try {
      const d1 = uuid();
      await h.c.payments.onTripCompleted(h.completed({ driverId: d1, fareMinor: 40_000, cityId: city })); // cash
      await h.c.payments.onTripCompleted(h.completed({ driverId: d1, fareMinor: 40_000, cityId: city, paymentMethod: "CORPORATE", billingOrgId: uuid() }));
      const cardId = (await h.c.payments.onTripCompleted(h.completed({ driverId: d1, fareMinor: 40_000, cityId: city, paymentMethod: "CARD" })))!;
      await h.c.gateways.simulator.decide((await h.c.db.payment.findUniqueOrThrow({ where: { id: cardId } })).providerRef!, "SUCCEEDED");
      await h.c.payments.onTripCancelled({ ...h.cancelled({ driverId: d1, feeMinor: 3000, compensationMinor: 2400 }), cityId: city });
      // a refund on the card payment
      const refund = await h.ok<{ id: string }>(h.req("POST", `/api/payments/payments/${cardId}/refunds`, await h.financeOfficer(), { amountMinor: 5000, reason: "a much longer route" }), 201);
      expect(await h.ok(h.req("POST", `/api/payments/refunds/${refund.id}/approve`, await h.financeManager()))).toMatchObject({ status: "SUCCEEDED" });
      // office cash top-up
      const b = (await h.balanceOf("INDIVIDUAL", d1))!;
      const top = await h.ok<{ id: string }>(h.req("POST", "/api/payments/top-ups/manual", await h.financeOfficer(), { accountId: b.accountId, channel: "OFFICE_CASH", amountMinor: 10_000, receiptNo: `R-${uuid().slice(0, 8)}` }), 201);
      await h.ok(h.req("POST", `/api/payments/top-ups/${top.id}/approve`, await h.financeManager()));
      // a payout line paid that day (batches are one per day, so made directly here)
      const batch = await h.c.db.payoutBatch.create({
        data: { cycleEnd: new Date(Date.UTC(1990, 0, 1 + Math.floor(Math.random() * 3000))), status: "COMPLETED", lines: { create: { beneficiaryAccountId: b.accountId, amountMinor: 7777n, status: "SUCCEEDED" } } },
        include: { lines: true },
      });
      await h.c.db.$executeRaw`UPDATE payout_line SET updated_at = ${new Date(h.clock.now)} WHERE id = ${batch.lines[0]!.id}::uuid`;
      // the next day, in this city and elsewhere
      h.clock.now = Date.parse("2026-09-15T22:00:00Z"); // 01:00 on the 16th in Addis
      await h.c.payments.onTripCompleted(h.completed({ driverId: uuid(), fareMinor: 20_000, cityId: city }));
      await h.c.payments.onTripCompleted(h.completed({ driverId: uuid(), fareMinor: 20_000, cityId: freshCity() }));
    } finally {
      h.clock.now = saved;
    }

    const auditor = await h.staff([{ r: "AUDITOR" }]);
    type Report = { cityId: string | null; from: string; to: string; days: Record<string, unknown>[]; totals: Record<string, unknown> };
    const r = await h.ok<Report>(h.req("GET", `/api/payments/reports/daily?cityId=${city}&from=2026-09-14&to=2026-09-16`, auditor));
    expect(r).toMatchObject({ cityId: city, from: "2026-09-14", to: "2026-09-16" });
    expect(r.days.map((d) => d.date)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
    expect(r.days[0]).toMatchObject({ trips: 0, fareMinor: 0, refunds: { count: 0, amountMinor: 0 } });
    expect(r.days[1]).toMatchObject({
      trips: 3, fareMinor: 120_000, vatMinor: 2700,
      // trip commission + the platform's share of the fee (30 − 24 ETB)
      commissionMinor: 18_600,
      byMethod: {
        CASH: { trips: 1, fareMinor: 40_000, commissionMinor: 6000, vatMinor: 900 },
        CARD: { trips: 1, fareMinor: 40_000 }, CORPORATE: { trips: 1, fareMinor: 40_000 },
      },
      cancellationFees: { count: 1, feeMinor: 3000, commissionMinor: 600 },
      collections: { CARD: { count: 1, amountMinor: 40_000 } },
      refunds: { count: 1, amountMinor: 5000 },
      payouts: { count: 1, amountMinor: 7777 },
      topUps: { OFFICE_CASH: { count: 1, amountMinor: 10_000 } },
    });
    expect(r.days[2]).toMatchObject({ trips: 1, fareMinor: 20_000 });
    expect(r.totals).toMatchObject({ trips: 4, fareMinor: 140_000 });

    // every city: at least these, plus the other city's trip
    const all = await h.ok<Report>(h.req("GET", "/api/payments/reports/daily?from=2026-09-16&to=2026-09-16", auditor));
    expect(all.cityId).toBeNull();
    expect(Number(all.totals.trips)).toBeGreaterThanOrEqual(2);

    const csv = await h.req("GET", `/api/payments/reports/daily.csv?cityId=${city}&from=2026-09-14&to=2026-09-16`, await h.financeOfficer());
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers["content-disposition"]).toBe(`attachment; filename="payments-${city}-2026-09-14-2026-09-16.csv"`);
    const lines = csv.body.trim().split("\r\n");
    expect(lines).toHaveLength(5);
    const header = lines[0]!.split(",");
    const day15 = Object.fromEntries(lines[2]!.split(",").map((v, i) => [header[i], v]));
    expect(day15).toMatchObject({ date: "2026-09-15", trips: "3", cash_fare_minor: "40000", collected_card_minor: "40000", refund_minor: "5000", payout_minor: "7777", topup_office_cash_minor: "10000" });
    expect(lines[4]!.startsWith("total,4,140000,")).toBe(true);
  });

  it("is for report:read_finance holders only", async () => {
    const q = "from=2026-09-15&to=2026-09-15";
    expect((await h.req("GET", `/api/payments/reports/daily?${q}`, await h.staff([{ r: "ANALYST", city: "addis-ababa" }]))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/payments/reports/daily?cityId=addis-ababa&${q}`, await h.staff([{ r: "OPERATIONS_MANAGER", city: "addis-ababa" }]))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/payments/reports/daily.csv?${q}`, await h.staff([{ r: "SUPER_ADMIN" }]))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/payments/reports/daily?${q}`, await h.person([{ r: "FLEET_OWNER", org: uuid() }]))).statusCode).toBe(403);
    expect((await h.req("GET", "/api/payments/reports/daily?from=2026-01-01&to=2026-12-31", await h.financeOfficer())).json()).toMatchObject({ error: "invalid_range" });
    // the default range is the last 7 days up to today
    expect((await h.ok<{ days: unknown[] }>(h.req("GET", "/api/payments/reports/daily", await h.financeManager()))).days).toHaveLength(7);
  });
});
