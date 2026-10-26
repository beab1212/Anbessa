import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CITY, createHarness, uuid, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

// Default rule and policy (Payment.md §19): 15% commission (at least 10 ETB), VAT 15% of the
// commission. A 400 ETB fare: commission 60, VAT 9 → cash −69 ETB, digital +331 ETB.

describe("settling trips (workflow 08)", () => {
  it("cash: the driver owes commission + VAT; a replayed event settles once", async () => {
    const d = uuid();
    const e = h.completed({ driverId: d, fareMinor: 40_000 });
    await h.c.payments.onTripCompleted(e);
    await h.c.payments.onTripCompleted(e);
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: -6900, state: "OK" });
    expect(await h.c.db.journalEntry.count({ where: { referenceId: e.tripId } })).toBe(1);
    const settled = (await h.outbox("trip.settled")).find((o) => (o.payload as { tripId: string }).tripId === e.tripId);
    expect(settled?.payload).toMatchObject({ paymentMethod: "CASH", fareMinor: 40_000, commissionMinor: 6000, vatMinor: 900, earningsMinor: -6900 });
  });

  it("card: the rider approves at the provider, the callback credits the driver; replays and forgeries do nothing", async () => {
    const d = uuid();
    const rider = await h.person();
    const e = h.completed({ driverId: d, fareMinor: 40_000, paymentMethod: "CARD", riderId: rider.id });
    const paymentId = await h.c.payments.onTripCompleted(e);
    const pay = await h.c.db.payment.findUniqueOrThrow({ where: { id: paymentId! } });
    expect(pay).toMatchObject({ status: "ACTION_REQUIRED", provider: "chapa", attempts: 1 });
    expect(pay.checkoutUrl).toMatch(/^http:\/\/pay\.test\/api\/payments\/sim\/checkout\//);
    expect(h.pushes.some((x) => x.userId === rider.id && x.event === "payment:action_required")).toBe(true);
    expect(await h.balanceOf("INDIVIDUAL", d)).toBeNull(); // nothing is credited before the money arrives

    // the hosted checkout page: approve
    const path = new URL(pay.checkoutUrl!).pathname;
    const page = await h.app.inject({ method: "GET", url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("400.00 ETB");
    const pressed = await h.app.inject({ method: "POST", url: path, payload: "secret=4242&decision=approve", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(pressed.statusCode).toBe(303);

    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id: pay.id } })).toMatchObject({ status: "SUCCEEDED" });
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: 33_100 });

    // the provider sends it again: no second credit
    await h.c.gateways.simulator.resend(pay.providerRef!);
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: 33_100 });
    const events = await h.c.db.webhookEvent.findMany({ where: { provider: "chapa" } });
    expect(events.some((x) => x.outcome === "captured")).toBe(true);

    // a forged callback is refused and kept for review
    const forged = await h.app.inject({
      method: "POST", url: "/api/payments/webhooks/chapa", headers: { "content-type": "application/json", "chapa-signature": "00".repeat(32) },
      payload: JSON.stringify({ event: "charge.success", tx_ref: "ANBP" + "0".repeat(32), status: "success", amount: "999.00" }),
    });
    expect(forged.statusCode).toBe(401);
    expect(await h.c.db.webhookEvent.count({ where: { provider: "chapa", signatureOk: false } })).toBeGreaterThan(0);

    // the rider sees their payment, not the driver's commission
    const mine = await h.ok<{ payments: { status: string }[]; settlements: unknown[] }>(h.req("GET", `/api/payments/trips/${e.tripId}`, rider));
    expect(mine.payments[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(mine.settlements).toEqual([]);
    const fm = await h.financeManager();
    const staffView = await h.ok<{ settlements: { commissionMinor: number }[] }>(h.req("GET", `/api/payments/trips/${e.tripId}`, fm));
    expect(staffView.settlements[0]).toMatchObject({ commissionMinor: 6000, earningsMinor: 33_100 });
  });

  it("corporate: the company owes the fare; the driver is credited at once", async () => {
    const d = uuid();
    const org = uuid();
    await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: org }));
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: 33_100 });
    expect(await h.accountBalance(`CORPORATE_RECEIVABLE:${org}`)).toBe(-40_000);
  });

  it("a cash cancellation fee becomes a rider receivable; the driver is compensated", async () => {
    const d = uuid();
    const e = h.cancelled({ driverId: d, feeMinor: 3000, compensationMinor: 2400 });
    await h.c.payments.onTripCancelled(e);
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: 2400 });
    expect(await h.accountBalance(`RIDER_RECEIVABLE:${e.riderId}`)).toBe(-3000);
    // a card rider's fee is charged instead
    const card = h.cancelled({ driverId: d, feeMinor: 3000, compensationMinor: 2400, paymentMethod: "MOBILE_MONEY" });
    const id = await h.c.payments.onTripCancelled(card);
    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id: id! } })).toMatchObject({ purpose: "CANCELLATION_FEE", provider: "telebirr", status: "ACTION_REQUIRED" });
  });
});

describe("balance limits (Payment.md §8)", () => {
  it("cash trips pause cash requests; a card trip repays the debt and lifts it", async () => {
    const d = uuid();
    for (let i = 0; i < 3; i++) await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 100_000 }));
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: -51_750, state: "CASH_BLOCKED" });
    const internal = await h.app.inject({ method: "GET", url: `/internal/balances/state?type=INDIVIDUAL&ownerId=${d}`, headers: { authorization: `Bearer ${"t".repeat(64)}` } });
    expect(internal.json()).toMatchObject({ state: "CASH_BLOCKED", cashAllowed: false, known: true });

    const pid = await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 40_000, paymentMethod: "MOBILE_MONEY" }));
    const pay = await h.c.db.payment.findUniqueOrThrow({ where: { id: pid! } });
    await h.c.gateways.simulator.decide(pay.providerRef!, "SUCCEEDED");
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: -18_650, state: "OK" });

    const changes = (await h.outbox("balance.state_changed")).map((o) => o.payload as { beneficiary: { id: string }; state: string; cashAllowed: boolean }).filter((p) => p.beneficiary.id === d);
    expect(changes.map((c) => [c.state, c.cashAllowed])).toEqual([["WARNING", true], ["CASH_BLOCKED", false], ["OK", true]]);
  });
});

describe("declined charges (workflow 08 step 6)", () => {
  it("are retried, then settled as a rider receivable; paying later collects it", async () => {
    const d = uuid();
    const rider = await h.person();
    const e = h.completed({ driverId: d, fareMinor: 40_000, paymentMethod: "MOBILE_MONEY", riderId: rider.id });
    const id = (await h.c.payments.onTripCompleted(e))!;
    const ref = async () => (await h.c.db.payment.findUniqueOrThrow({ where: { id } })).providerRef!;

    await h.c.gateways.simulator.decide(await ref(), "FAILED", "insufficient funds");
    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "RETRY_SCHEDULED", lastError: "insufficient funds" });
    h.clock.now += 61_000;
    await h.c.payments.chargeDue();
    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "ACTION_REQUIRED", attempts: 2 });
    await h.c.gateways.simulator.decide(await ref(), "FAILED");
    h.clock.now += 601_000;
    await h.c.payments.chargeDue();
    await h.c.gateways.simulator.decide(await ref(), "FAILED");

    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", attempts: 3, settledAsReceivable: true });
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: 33_100 }); // the driver is paid anyway (Q6)
    expect(await h.accountBalance(`RIDER_RECEIVABLE:${rider.id}`)).toBe(-40_000);

    const again = await h.ok<{ status: string; attempts: number }>(h.req("POST", `/api/payments/payments/${id}/pay`, rider));
    expect(again).toMatchObject({ status: "ACTION_REQUIRED", attempts: 4 });
    await h.c.gateways.simulator.decide(await ref(), "SUCCEEDED");
    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "SUCCEEDED" });
    expect(await h.accountBalance(`RIDER_RECEIVABLE:${rider.id}`)).toBe(0);
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: 33_100 }); // not credited twice
  });

  it("a lost callback is recovered by reconciliation", async () => {
    const d = uuid();
    const id = (await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 40_000, paymentMethod: "MOBILE_MONEY" })))!;
    const pay = await h.c.db.payment.findUniqueOrThrow({ where: { id } });
    h.callbacks.drop = true;
    await h.c.gateways.simulator.decide(pay.providerRef!, "SUCCEEDED");
    h.callbacks.drop = false;
    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "ACTION_REQUIRED" });
    h.clock.now += 130_000;
    expect(await h.c.payments.reconcile(120)).toBeGreaterThanOrEqual(1);
    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "SUCCEEDED" });
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: 33_100 });
  });
});

describe("top-ups (workflow 09 B–C)", () => {
  it("mobile money: the provider's callback credits the balance; a retried request is the same top-up", async () => {
    const d = await h.driver();
    const opened = await h.ok<{ accountId: string; balanceMinor: number; referenceCode: string }>(h.req("GET", "/api/payments/balances/me?open=true", d));
    expect(opened).toMatchObject({ balanceMinor: 0 });
    const headers = { "idempotency-key": `topup-${uuid()}` };
    const t = await h.ok<{ id: string; status: string; checkoutUrl: string }>(h.req("POST", `/api/payments/balances/${opened.accountId}/top-ups`, d, { amountMinor: 60_000, provider: "telebirr" }, headers), 201);
    expect(t.status).toBe("ACTION_REQUIRED");
    const same = await h.ok<{ id: string }>(h.req("POST", `/api/payments/balances/${opened.accountId}/top-ups`, d, { amountMinor: 60_000, provider: "telebirr" }, headers), 201);
    expect(same.id).toBe(t.id);

    const row = await h.c.db.topUp.findUniqueOrThrow({ where: { id: t.id } });
    await h.c.gateways.simulator.decide(row.providerRef!, "SUCCEEDED");
    expect(await h.ok(h.req("GET", `/api/payments/top-ups/${t.id}`, d))).toMatchObject({ status: "SUCCEEDED" });
    expect(await h.balanceOf("INDIVIDUAL", d.id)).toMatchObject({ balance: 60_000 });
    const statement = await h.ok<{ entries: { kind: string; amountMinor: number }[] }>(h.req("GET", `/api/payments/balances/${opened.accountId}/statement`, d));
    expect(statement.entries[0]).toMatchObject({ kind: "TOP_UP", amountMinor: 60_000 });
    // card providers don't take top-ups
    expect((await h.req("POST", `/api/payments/balances/${opened.accountId}/top-ups`, d, { amountMinor: 60_000, provider: "chapa" })).json()).toMatchObject({ error: "unknown_provider" });
  });

  it("office cash: recorded by one finance person, credited when another approves", async () => {
    const d = uuid();
    await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 40_000 }));
    const b = (await h.balanceOf("INDIVIDUAL", d))!;
    const officer = await h.financeOfficer();
    const t = await h.ok<{ id: string; status: string }>(h.req("POST", "/api/payments/top-ups/manual", officer, { referenceCode: b.referenceCode, channel: "OFFICE_CASH", amountMinor: 20_000, receiptNo: `R-${uuid().slice(0, 8)}` }), 201);
    expect(t.status).toBe("PENDING_APPROVAL");
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: -6900 });
    expect((await h.req("POST", `/api/payments/top-ups/${t.id}/approve`, officer)).statusCode).toBe(403);

    // a manager who also recorded it can't approve it either
    const manager = await h.financeManager();
    const self = await h.staff([{ r: "FINANCE_OFFICER" }, { r: "FINANCE_MANAGER" }]);
    const own = await h.ok<{ id: string }>(h.req("POST", "/api/payments/top-ups/manual", self, { accountId: b.accountId, channel: "BANK_TRANSFER", amountMinor: 5000, receiptNo: `BT-${uuid().slice(0, 8)}` }), 201);
    expect((await h.req("POST", `/api/payments/top-ups/${own.id}/approve`, self)).json()).toMatchObject({ error: "maker_checker" });

    expect(await h.ok(h.req("POST", `/api/payments/top-ups/${t.id}/approve`, manager))).toMatchObject({ status: "SUCCEEDED" });
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: 13_100 });
    expect(await h.accountBalance(`CASH_RECEIPTS:${CITY}`)).toBeLessThanOrEqual(-20_000);
  });
});

describe("refunds (workflow 13)", () => {
  it("are asked for by support, approved by finance, and charged to the driver when at fault", async () => {
    const d = uuid();
    const id = (await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 40_000, paymentMethod: "CARD" })))!;
    await h.c.gateways.simulator.decide((await h.c.db.payment.findUniqueOrThrow({ where: { id } })).providerRef!, "SUCCEEDED");
    const support = await h.staff([{ r: "SUPPORT_AGENT", city: CITY }]);
    const r = await h.ok<{ id: string; status: string }>(h.req("POST", `/api/payments/payments/${id}/refunds`, support, { amountMinor: 10_000, reason: "took a much longer route", driverAtFault: true }), 201);
    expect(r.status).toBe("PENDING_APPROVAL");
    expect((await h.req("POST", `/api/payments/refunds/${r.id}/approve`, support)).statusCode).toBe(403);
    expect((await h.req("POST", `/api/payments/payments/${id}/refunds`, support, { amountMinor: 30_001, reason: "everything else too" })).json()).toMatchObject({ error: "refund_too_large" });

    const fm = await h.financeManager();
    expect(await h.ok(h.req("POST", `/api/payments/refunds/${r.id}/approve`, fm))).toMatchObject({ status: "SUCCEEDED" });
    expect(await h.c.db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedMinor: 10_000n });
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: 23_100 });
  });
});

describe("weekly settlement and payouts (workflow 09 D–E)", () => {
  it("pays positive balances after a second person approves; negative ones get a due that blocks when overdue", async () => {
    const owner = await h.driver();
    await h.c.payments.onTripCompleted(h.completed({ driverId: owner.id, fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: uuid() }));
    const a = (await h.balanceOf("INDIVIDUAL", owner.id))!;
    await h.ok(h.req("PUT", `/api/payments/balances/${a.accountId}/payout-method`, owner, { provider: "telebirr", destination: "+251 911 22 33 44" }));

    const closed = await h.driver();
    await h.c.payments.onTripCompleted(h.completed({ driverId: closed.id, fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: uuid() }));
    const c = (await h.balanceOf("INDIVIDUAL", closed.id))!;
    await h.ok(h.req("PUT", `/api/payments/balances/${c.accountId}/payout-method`, closed, { provider: "cbebirr", destination: "+251911220000" }));

    const debtor = uuid();
    for (let i = 0; i < 2; i++) await h.c.payments.onTripCompleted(h.completed({ driverId: debtor, fareMinor: 100_000 }));
    const b = (await h.balanceOf("INDIVIDUAL", debtor))!;
    expect(b.balance).toBe(-34_500);

    const officer = await h.financeOfficer();
    const run = await h.ok<{ batch: { id: string; status: string; lineCount: number }; created: boolean }>(h.req("POST", "/api/payments/settlements/run", officer), 201);
    expect(run.batch.status).toBe("PENDING_APPROVAL");
    const rerun = await h.ok<{ batch: { id: string }; created: boolean }>(h.req("POST", "/api/payments/settlements/run", officer));
    expect(rerun).toMatchObject({ created: false, batch: { id: run.batch.id } });
    const due = await h.c.db.paymentDue.findFirstOrThrow({ where: { beneficiaryAccountId: b.accountId } });
    expect(due).toMatchObject({ amountMinor: 34_500n, minimumMinor: 17_250n, status: "OPEN" });

    expect((await h.req("POST", `/api/payments/payouts/${run.batch.id}/approve`, officer)).statusCode).toBe(403);
    const fm = await h.financeManager();
    await h.ok(h.req("POST", `/api/payments/payouts/${run.batch.id}/approve`, fm));
    await h.until(async () => (await h.c.db.payoutLine.count({ where: { batchId: run.batch.id, status: "SENT" } })) === 0);

    const batch = await h.ok<{ status: string; lines: { accountId: string; status: string; failure: string | null }[] }>(h.req("GET", `/api/payments/payouts/${run.batch.id}`, fm));
    expect(batch.lines.find((l) => l.accountId === a.accountId)).toMatchObject({ status: "SUCCEEDED" });
    expect(batch.lines.find((l) => l.accountId === c.accountId)).toMatchObject({ status: "FAILED", failure: "the receiving account is closed" });
    expect(batch.status).toBe("COMPLETED");
    expect(await h.balanceOf("INDIVIDUAL", owner.id)).toMatchObject({ balance: 0 });
    expect(await h.balanceOf("INDIVIDUAL", closed.id)).toMatchObject({ balance: 33_100 }); // reversed

    // the due's deadline passes: blocked; paying the minimum lifts it
    h.clock.now += 4 * 86_400_000;
    await h.c.payouts.overdueSweep();
    expect(await h.balanceOf("INDIVIDUAL", debtor)).toMatchObject({ state: "BLOCKED" });
    const cash = await h.ok<{ id: string }>(h.req("POST", "/api/payments/top-ups/manual", officer, { accountId: b.accountId, channel: "OFFICE_CASH", amountMinor: 17_250, receiptNo: `R-${uuid().slice(0, 8)}` }), 201);
    await h.ok(h.req("POST", `/api/payments/top-ups/${cash.id}/approve`, fm));
    expect(await h.balanceOf("INDIVIDUAL", debtor)).toMatchObject({ balance: -17_250, state: "OK" });
    expect(await h.c.db.paymentDue.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({ status: "MIN_PAID", paidMinor: 17_250n });
  });
});

describe("commission rules and balance policies (maker–checker)", () => {
  const CITY2 = "dire-dawa";

  it("operations proposes, finance approves; the next trip uses the new rule", async () => {
    const ops = await h.staff([{ r: "OPERATIONS_MANAGER", city: CITY2 }]);
    const proposal = await h.ok<{ id: string; status: string }>(h.req("POST", "/api/payments/rules/changes", ops, {
      kind: "COMMISSION_RULE", cityId: CITY2, reason: "launch rate for Dire Dawa", payload: { model: "PERCENT", rateBp: 1000 },
    }), 202);
    expect((await h.req("POST", `/api/payments/rules/changes/${proposal.id}/approve`, ops)).statusCode).toBe(403);
    const fm = await h.financeManager();
    expect(await h.ok(h.req("POST", `/api/payments/rules/changes/${proposal.id}/approve`, fm))).toMatchObject({ status: "EXECUTED" });

    const d = uuid();
    h.clock.now += 1000;
    await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 40_000, cityId: CITY2 }));
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ balance: -4600 }); // 10% + 15% VAT on it

    // tighter limits apply to existing balances as soon as they're approved
    const policy = await h.ok<{ id: string }>(h.req("POST", "/api/payments/rules/changes", ops, {
      kind: "BALANCE_POLICY", cityId: CITY2, reason: "small limits while we learn the market",
      payload: { mode: "POSTPAID", warningMinor: -2000, cashLimitMinor: -3000, hardLimitMinor: -10_000, prepaidMinimumMinor: 0, dueDays: 3, minPaymentBp: 5000, minPayoutMinor: 10_000, taxBasis: "COMMISSION", vatRateBp: 1500 },
    }), 202);
    await h.ok(h.req("POST", `/api/payments/rules/changes/${policy.id}/approve`, fm));
    expect(await h.balanceOf("INDIVIDUAL", d)).toMatchObject({ state: "CASH_BLOCKED" });

    const bad = await h.req("POST", "/api/payments/rules/changes", ops, {
      kind: "BALANCE_POLICY", cityId: CITY2, reason: "limits in the wrong order",
      payload: { mode: "POSTPAID", warningMinor: -5000, cashLimitMinor: -3000, hardLimitMinor: -10_000, prepaidMinimumMinor: 0, dueDays: 3, minPaymentBp: 5000, minPayoutMinor: 10_000, taxBasis: "COMMISSION", vatRateBp: 1500 },
    });
    expect(bad.json()).toMatchObject({ error: "invalid_rule" });
    const overview = await h.ok<{ rules: { rateBp: number; inForce: boolean }[]; policy: { builtIn: boolean } }>(h.req("GET", `/api/payments/rules?cityId=${CITY2}`, fm));
    expect(overview.rules.find((r) => r.inForce)).toMatchObject({ rateBp: 1000 });
    expect(overview.policy.builtIn).toBe(false);
  });
});

describe("who sees what", () => {
  it("owners see their own balance, fleets theirs; others get 404; finance lists", async () => {
    const d = await h.driver();
    await h.c.payments.onTripCompleted(h.completed({ driverId: d.id, fareMinor: 40_000 }));
    const b = (await h.balanceOf("INDIVIDUAL", d.id))!;
    expect(await h.ok(h.req("GET", `/api/payments/balances/${b.accountId}`, d))).toMatchObject({ balanceMinor: -6900, cashAllowed: true });
    expect((await h.req("GET", `/api/payments/balances/${b.accountId}`, await h.driver())).statusCode).toBe(404);

    const org = uuid();
    await h.c.payments.onTripCompleted(h.completed({ driverId: uuid(), fleetOrgId: org, fareMinor: 40_000 }));
    const owner = await h.person([{ r: "FLEET_OWNER", org }]);
    const fleet = await h.ok<{ accountId: string; balanceMinor: number }>(h.req("GET", `/api/payments/balances/org/${org}`, owner));
    expect(fleet.balanceMinor).toBe(-6900);
    expect((await h.req("POST", `/api/payments/balances/${fleet.accountId}/top-ups`, d, { amountMinor: 10_000, provider: "telebirr" })).statusCode).toBe(404);

    expect((await h.req("GET", "/api/payments/balances", d)).statusCode).toBe(403);
    const list = await h.ok<{ balances: { accountId: string }[] }>(h.req("GET", "/api/payments/balances?type=ORGANIZATION", await h.financeOfficer()));
    expect(list.balances.some((x) => x.accountId === fleet.accountId)).toBe(true);
  });

  it("the ledger balances, and history can't be edited", async () => {
    const r = await h.ok<{ ok: boolean; totalMinor: number; mismatched: unknown[] }>(h.req("GET", "/api/payments/ledger/integrity", await h.financeManager()));
    expect(r).toMatchObject({ ok: true, totalMinor: 0, mismatched: [] });
    await expect(h.c.db.$executeRawUnsafe("UPDATE posting SET amount_minor = amount_minor + 1")).rejects.toThrow(/append-only/);
    await expect(h.c.db.$executeRawUnsafe("DELETE FROM journal_entry")).rejects.toThrow(/append-only/);
  });
});
