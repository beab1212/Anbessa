// Security fixes: refunds can't pass the amount paid (row lock, re-check at approval, capped on
// completion); a payout method change is announced and waits out a cooling-off period; trip
// events are checked against trip-service's own record before any money is posted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeReference } from "../../src/gateways/index.js";
import type { TripFacts } from "../../src/lib/trips.js";
import { CITY, createHarness, uuid, type Harness } from "./harness.js";

const HOUR = 3_600_000;
let h: Harness;
let checked: Harness;
const records = new Map<string, TripFacts>();
let tripServiceDown = false;
beforeAll(async () => {
  h = await createHarness();
  checked = await createHarness({
    trips: {
      get: async (id) => {
        if (tripServiceDown) throw new Error("connect ECONNREFUSED");
        return records.get(id) ?? null;
      },
    },
  });
});
afterAll(async () => {
  await h?.close();
  await checked?.close();
});

/** A card payment of `fareMinor` the rider has paid. */
async function paidCard(fareMinor = 40_000) {
  const id = (await h.c.payments.onTripCompleted(h.completed({ driverId: uuid(), fareMinor, paymentMethod: "CARD" })))!;
  await h.c.gateways.simulator.decide((await h.c.db.payment.findUniqueOrThrow({ where: { id } })).providerRef!, "SUCCEEDED");
  return id;
}

describe("refunds never exceed the amount paid", () => {
  it("parallel requests: only what fits is accepted", async () => {
    const id = await paidCard();
    const support = await h.staff([{ r: "SUPPORT_AGENT", city: CITY }]);
    const asks = await Promise.all(Array.from({ length: 4 }, () => h.req("POST", `/api/payments/payments/${id}/refunds`, support, { amountMinor: 15_000, reason: "a much longer route", driverAtFault: false })));
    expect(asks.filter((r) => r.statusCode === 201)).toHaveLength(2);
    expect(asks.filter((r) => r.statusCode === 400).map((r) => r.json().error)).toEqual(["refund_too_large", "refund_too_large"]);
    const pending = await h.c.db.refund.aggregate({ where: { paymentId: id }, _sum: { amountMinor: true } });
    expect(pending._sum.amountMinor).toBe(30_000n);
  });

  it("approval re-checks what is left; completion caps refundedMinor at the amount", async () => {
    const id = await paidCard();
    const support = await h.staff([{ r: "SUPPORT_AGENT", city: CITY }]);
    const fm = await h.financeManager();
    // two requests that together exceed the payment (made before the fix, or by a bug): the second approval is refused
    const a = await h.c.db.refund.create({ data: { paymentId: id, amountMinor: 30_000n, reason: "a", driverAtFault: false, requestedBy: support.id } });
    const b = await h.c.db.refund.create({ data: { paymentId: id, amountMinor: 30_000n, reason: "b", driverAtFault: false, requestedBy: support.id } });
    expect(await h.ok(h.req("POST", `/api/payments/refunds/${a.id}/approve`, fm))).toMatchObject({ status: "SUCCEEDED" });
    const second = await h.req("POST", `/api/payments/refunds/${b.id}/approve`, fm);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "refund_too_large" });
    expect((await h.c.db.refund.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("PENDING_APPROVAL");

    // a provider confirming a refund past the amount: the payment never shows more refunded than paid
    const c = await h.c.db.refund.create({ data: { paymentId: id, amountMinor: 20_000n, reason: "c", driverAtFault: false, requestedBy: support.id, status: "PROCESSING", approvedBy: fm.id } });
    expect(await h.c.payments.applyRefund({ kind: "refund", reference: makeReference("refund", c.id), providerRef: null, providerTxnId: null, status: "SUCCEEDED", amountMinor: 20_000, eventKey: uuid() })).toBe("refunded");
    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ refundedMinor: 40_000n, status: "REFUNDED" });
  });
});

describe("payout method changes", () => {
  it("are announced to the owner and wait out the cooling-off period; a change after the run holds the line", async () => {
    // a day no other batch uses
    h.clock.now += 40 * 24 * HOUR;
    const owner = await h.driver();
    await h.c.payments.onTripCompleted(h.completed({ driverId: owner.id, fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: uuid() }));
    const acct = (await h.balanceOf("INDIVIDUAL", owner.id))!;
    // the first method redirects nothing: announced, but no cooling-off
    await h.ok(h.req("PUT", `/api/payments/balances/${acct.accountId}/payout-method`, owner, { provider: "cbebirr", destination: "+251900000099" }));
    const first = (await h.outbox("payout_method.changed")).filter((e) => (e.payload as { accountId: string }).accountId === acct.accountId);
    expect(first).toHaveLength(1);
    expect(first[0]!.payload).toMatchObject({ provider: "cbebirr", previousProvider: null, previousDestinationMasked: null });
    expect(new Date((first[0]!.payload as { payoutsResumeAt: string }).payoutsResumeAt).getTime()).toBe(h.clock.now);
    await h.ok(h.req("PUT", `/api/payments/balances/${acct.accountId}/payout-method`, owner, { provider: "telebirr", destination: "+251 911 22 33 44" }));
    // setting the same method again changes nothing (no new event, the clock isn't restarted)
    await h.ok(h.req("PUT", `/api/payments/balances/${acct.accountId}/payout-method`, owner, { provider: "telebirr", destination: "+251911223344" }));
    const told = (await h.outbox("payout_method.changed")).filter((e) => (e.payload as { accountId: string }).accountId === acct.accountId);
    expect(told).toHaveLength(2);
    expect(told[1]!.key).toBe(owner.id);
    expect(told[1]!.payload).toMatchObject({ provider: "telebirr", destinationMasked: "•••3344", previousProvider: "cbebirr", previousDestinationMasked: "•••0099", changedBy: owner.id, beneficiary: { type: "INDIVIDUAL", id: owner.id } });
    expect(JSON.stringify(told[1]!.payload)).not.toContain("911223344");
    expect(new Date((told[1]!.payload as { payoutsResumeAt: string }).payoutsResumeAt).getTime()).toBe(h.clock.now + 72 * HOUR);

    // this run holds it: nothing debited, the reason on the line
    const officer = await h.financeOfficer();
    const fm = await h.financeManager();
    const run1 = await h.ok<{ batch: { id: string } }>(h.req("POST", "/api/payments/settlements/run", officer), 201);
    const line1 = await h.c.db.payoutLine.findFirstOrThrow({ where: { batchId: run1.batch.id, beneficiaryAccountId: acct.accountId } });
    expect(line1).toMatchObject({ status: "HELD" });
    expect(line1.failure).toMatch(/payout method changed recently: held until/);
    // (other tests' balances may be in the batch; with nothing else to pay it is already complete)
    if ((await h.c.db.payoutBatch.findUniqueOrThrow({ where: { id: run1.batch.id } })).status === "PENDING_APPROVAL") {
      await h.ok(h.req("POST", `/api/payments/payouts/${run1.batch.id}/approve`, fm));
    }
    expect(await h.balanceOf("INDIVIDUAL", owner.id)).toMatchObject({ balance: 33_100 });

    // after the cooling-off period the next run pays it
    h.clock.now += 73 * HOUR;
    const run2 = await h.ok<{ batch: { id: string } }>(h.req("POST", "/api/payments/settlements/run", officer), 201);
    expect(await h.c.db.payoutLine.findFirstOrThrow({ where: { batchId: run2.batch.id, beneficiaryAccountId: acct.accountId } })).toMatchObject({ status: "PENDING" });
    // … unless the method changes again before the batch is approved: that line is held too
    await h.ok(h.req("PUT", `/api/payments/balances/${acct.accountId}/payout-method`, owner, { provider: "cbebirr", destination: "+251922000011" }));
    const second = (await h.outbox("payout_method.changed")).filter((e) => (e.payload as { accountId: string }).accountId === acct.accountId).at(-1)!;
    expect(second.payload).toMatchObject({ provider: "cbebirr", destinationMasked: "•••0011", previousProvider: "telebirr", previousDestinationMasked: "•••3344" });
    await h.ok(h.req("POST", `/api/payments/payouts/${run2.batch.id}/approve`, fm));
    expect(await h.c.db.payoutLine.findFirstOrThrow({ where: { batchId: run2.batch.id, beneficiaryAccountId: acct.accountId } })).toMatchObject({ status: "HELD" });
    expect(await h.balanceOf("INDIVIDUAL", owner.id)).toMatchObject({ balance: 33_100 });

    // and paid once that change has cooled off too
    h.clock.now += 73 * HOUR;
    const run3 = await h.ok<{ batch: { id: string } }>(h.req("POST", "/api/payments/settlements/run", officer), 201);
    await h.ok(h.req("POST", `/api/payments/payouts/${run3.batch.id}/approve`, fm));
    await h.until(async () => (await h.c.db.payoutLine.count({ where: { batchId: run3.batch.id, status: "SENT" } })) === 0);
    expect(await h.c.db.payoutLine.findFirstOrThrow({ where: { batchId: run3.batch.id, beneficiaryAccountId: acct.accountId } })).toMatchObject({ status: "SUCCEEDED", provider: "cbebirr" });
    expect(await h.balanceOf("INDIVIDUAL", owner.id)).toMatchObject({ balance: 0 });
  });
});

describe("trip events are checked against trip-service", () => {
  it("an event that agrees with the trip's record is posted", async () => {
    const e = checked.completed({ driverId: uuid(), fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: uuid() });
    records.set(e.tripId, checked.factsOf(e));
    await checked.c.payments.onTripCompleted(e);
    expect(await checked.c.db.tripSettlement.count({ where: { tripId: e.tripId } })).toBe(1);
    expect(await checked.c.db.tripEventAnomaly.count({ where: { tripId: e.tripId } })).toBe(0);
  });

  it("an inflated fare, a discount trip-service didn't give, or an unknown trip: nothing posted, an anomaly recorded once", async () => {
    const driver = uuid();
    const inflated = checked.completed({ driverId: driver, fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: uuid() });
    records.set(inflated.tripId, { ...checked.factsOf(inflated), fare: { ...checked.factsOf(inflated).fare, finalMinor: 20_000 } });
    const discounted = { ...checked.completed({ driverId: driver, fareMinor: 40_000 }), promoDiscountMinor: 40_000 };
    records.set(discounted.tripId, { ...checked.factsOf(discounted), fare: { ...checked.factsOf(discounted).fare, promoDiscountMinor: 0 } });
    const unknown = checked.completed({ driverId: driver, fareMinor: 40_000 });

    for (const e of [inflated, discounted, unknown]) {
      expect(await checked.c.payments.onTripCompleted(e)).toBeNull();
      await checked.c.payments.onTripCompleted(e); // replay
      expect(await checked.c.db.tripSettlement.count({ where: { tripId: e.tripId } })).toBe(0);
      expect(await checked.c.db.tripEventAnomaly.count({ where: { tripId: e.tripId } })).toBe(1);
    }
    expect((await checked.c.db.tripEventAnomaly.findUniqueOrThrow({ where: { eventId: inflated.eventId } })).mismatches).toEqual([{ field: "fareMinor", event: 40_000, trip: 20_000 }]);
    expect((await checked.c.db.tripEventAnomaly.findUniqueOrThrow({ where: { eventId: discounted.eventId } })).mismatches).toEqual([{ field: "promoDiscountMinor", event: 40_000, trip: 0 }]);
    expect((await checked.c.db.tripEventAnomaly.findUniqueOrThrow({ where: { eventId: unknown.eventId } })).mismatches).toEqual([{ field: "trip", event: unknown.tripId, trip: null }]);
    expect(await checked.balanceOf("INDIVIDUAL", driver)).toBeNull();
    expect((await checked.outbox("audit.recorded")).some((r) => (r.payload as { action: string; resource: { id: string } }).action === "trip_event:reject" && (r.payload as { resource: { id: string } }).resource.id === inflated.tripId)).toBe(true);
  });

  it("a cancellation fee that disagrees isn't charged", async () => {
    const e = checked.cancelled({ driverId: uuid(), feeMinor: 50_000, compensationMinor: 40_000, paymentMethod: "CARD" });
    records.set(e.tripId, { ...checked.factsOf(e), cancellation: { feeMinor: 5000, driverCompensationMinor: 4000 } });
    expect(await checked.c.payments.onTripCancelled(e)).toBeNull();
    expect(await checked.c.db.payment.count({ where: { tripId: e.tripId } })).toBe(0);
    expect((await checked.c.db.tripEventAnomaly.findUniqueOrThrow({ where: { eventId: e.eventId } })).mismatches).toEqual([
      { field: "feeMinor", event: 50_000, trip: 5000 }, { field: "driverCompensationMinor", event: 40_000, trip: 4000 },
    ]);
  });

  it("trip-service unreachable: the event fails (Kafka retries it), nothing is posted or consumed; the retry posts it", async () => {
    const e = checked.completed({ driverId: uuid(), fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: uuid() });
    records.set(e.tripId, checked.factsOf(e));
    tripServiceDown = true;
    try {
      await expect(checked.c.payments.onTripCompleted(e)).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      tripServiceDown = false;
    }
    expect(await checked.c.db.inbox.findUnique({ where: { eventId: e.eventId } })).toBeNull();
    expect(await checked.c.db.tripSettlement.count({ where: { tripId: e.tripId } })).toBe(0);
    await checked.c.payments.onTripCompleted(e);
    expect(await checked.c.db.tripSettlement.count({ where: { tripId: e.tripId } })).toBe(1);
  });
});
