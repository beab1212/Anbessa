import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrity } from "../../src/ledger/ledger.js";
import { addisMonth, periodOf } from "../../src/money/controls.js";
import { CITY, createHarness, uuid, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

const DAY = 86_400_000;
type Row = Record<string, unknown> & { id: string; status: string };

/** A driver whose balance is the cash commission + VAT of `fareMinor` (15% + 15% of it): −17.25% of the fare. */
async function cashDriver(fareMinor = 40_000, cityId = CITY) {
  const d = uuid();
  await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor, cityId }));
  return { id: d, accountId: (await h.balanceOf("INDIVIDUAL", d))!.accountId };
}

const journalBalances = async (entryId: string) => {
  const postings = await h.c.db.posting.findMany({ where: { journalEntryId: entryId }, include: { account: true } });
  return Object.fromEntries(postings.map((p) => [p.account.code, Number(p.amountMinor)]));
};

describe("balance adjustments (maker–checker)", () => {
  it("support asks in their city, finance approves; the ledger, the event and the audit follow", async () => {
    const d = await cashDriver(); // −69 ETB
    const support = await h.staff([{ r: "SUPPORT_AGENT", city: CITY }]);
    const elsewhere = await h.staff([{ r: "SUPPORT_AGENT", city: "hawassa" }]);
    const fm = await h.financeManager();
    const body = { accountId: d.accountId, direction: "CREDIT", amountMinor: 5000, category: "FEE_REVERSAL", reason: "cancellation fee charged by mistake", ticketId: "T-1001" };

    expect((await h.req("POST", "/api/payments/adjustments", elsewhere, body)).statusCode).toBe(403);
    const tooMuch = await h.req("POST", "/api/payments/adjustments", support, { ...body, amountMinor: 100_001 });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json()).toMatchObject({ error: "limit_exceeded" });

    // the same Idempotency-Key twice: one request
    const key = { "idempotency-key": `adj-${uuid()}` };
    const a = await h.ok<Row>(h.req("POST", "/api/payments/adjustments", support, body, key), 201);
    const again = await h.ok<Row>(h.req("POST", "/api/payments/adjustments", support, body, key), 201);
    expect(again.id).toBe(a.id);
    expect(await h.c.db.balanceAdjustment.count({ where: { beneficiaryAccountId: d.accountId } })).toBe(1);

    // the requester can't approve; nor can someone without adjustment:approve
    expect((await h.req("POST", `/api/payments/adjustments/${a.id}/approve`, support)).json()).toMatchObject({ error: "forbidden" });
    const otherSupport = await h.staff([{ r: "SUPPORT_AGENT", city: CITY }]);
    expect((await h.req("POST", `/api/payments/adjustments/${a.id}/approve`, otherSupport)).statusCode).toBe(403);
    const fmSelf = await h.req("POST", `/api/payments/adjustments/${a.id}/approve`, await h.staff([{ r: "FINANCE_MANAGER" }], support.id));
    expect(fmSelf.statusCode).toBe(403);
    expect(fmSelf.json()).toMatchObject({ error: "maker_checker" });

    // it's in the approvals inbox
    const inbox = await h.ok<{ adjustments: Row[] }>(h.req("GET", "/api/payments/approvals/pending", fm));
    expect(inbox.adjustments.find((x) => x.id === a.id)).toMatchObject({ referenceCode: expect.stringMatching(/^ANB-/), balanceMinor: -6900 });

    const done = await h.ok<Row>(h.req("POST", `/api/payments/adjustments/${a.id}/approve`, fm));
    expect(done).toMatchObject({ status: "EXECUTED", decidedBy: fm.id, balanceMinor: -1900 });
    expect(await h.balanceOf("INDIVIDUAL", d.id)).toMatchObject({ balance: -1900 });
    expect(await journalBalances(done.journalEntryId as string)).toEqual({ [`BENEFICIARY_BALANCE:INDIVIDUAL:${d.id}`]: 5000, GOODWILL_EXPENSE: -5000 });
    expect((await h.outbox("balance.adjusted")).map((o) => o.payload)).toContainEqual(expect.objectContaining({ adjustmentId: a.id, direction: "CREDIT", amountMinor: 5000, balanceMinor: -1900, ticketId: "T-1001" }));
    expect((await h.outbox("audit.recorded")).filter((o) => (o.payload as { resource: { id: string } }).resource.id === a.id).map((o) => (o.payload as { action: string }).action))
      .toEqual(["adjustment:request", "adjustment:approve"]);

    // decided once
    expect((await h.req("POST", `/api/payments/adjustments/${a.id}/approve`, await h.financeManager())).statusCode).toBe(409);
    // the database refuses maker = checker too
    await expect(h.c.db.$executeRaw`UPDATE balance_adjustment SET status = 'REJECTED', decided_by = requested_by WHERE id = ${a.id}::uuid`).rejects.toThrow();
  });

  it("a debit is rejected with a reason; the requester can withdraw; an old request expires", async () => {
    const d = await cashDriver();
    const fo = await h.financeOfficer();
    const fm = await h.financeManager();
    const debit = await h.ok<Row>(h.req("POST", "/api/payments/adjustments", fo, { accountId: d.accountId, direction: "DEBIT", amountMinor: 2000, category: "CORRECTION", reason: "duplicate goodwill credit" }), 201);
    expect((await h.req("POST", `/api/payments/adjustments/${debit.id}/reject`, fm)).json()).toMatchObject({ error: "reason_required" });
    expect(await h.ok<Row>(h.req("POST", `/api/payments/adjustments/${debit.id}/reject`, fm, { reason: "not a duplicate" }))).toMatchObject({ status: "REJECTED" });
    expect(await h.balanceOf("INDIVIDUAL", d.id)).toMatchObject({ balance: -6900 });

    const mine = await h.ok<Row>(h.req("POST", "/api/payments/adjustments", fo, { accountId: d.accountId, direction: "DEBIT", amountMinor: 2000, category: "CORRECTION", reason: "second try at a correction" }), 201);
    expect((await h.req("POST", `/api/payments/adjustments/${mine.id}/cancel`, fm)).statusCode).toBe(403);
    expect(await h.ok<Row>(h.req("POST", `/api/payments/adjustments/${mine.id}/cancel`, fo))).toMatchObject({ status: "CANCELLED" });

    const old = await h.ok<Row>(h.req("POST", "/api/payments/adjustments", fo, { accountId: d.accountId, direction: "CREDIT", amountMinor: 2000, category: "GOODWILL", reason: "long wait at pickup" }), 201);
    h.clock.now += 8 * DAY;
    try {
      expect((await h.req("POST", `/api/payments/adjustments/${old.id}/approve`, fm)).json()).toMatchObject({ error: "expired" });
      expect(await h.c.db.balanceAdjustment.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: "EXPIRED" });
    } finally {
      h.clock.now -= 8 * DAY;
    }
  });

  it("approval re-checks the 30-day credit cap", async () => {
    const d = await cashDriver();
    const fo = await h.financeOfficer();
    const fm = await h.financeManager();
    const ask = () => h.ok<Row>(h.req("POST", "/api/payments/adjustments", fo, { accountId: d.accountId, direction: "CREDIT", amountMinor: 600_000, category: "GOODWILL", reason: "service outage compensation" }), 201);
    const first = await ask();
    const second = await ask(); // fine when asked: nothing executed yet
    await h.ok(h.req("POST", `/api/payments/adjustments/${first.id}/approve`, fm));
    const r = await h.req("POST", `/api/payments/adjustments/${second.id}/approve`, fm);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "limit_exceeded" });
    expect(await h.c.db.balanceAdjustment.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: "PENDING_APPROVAL", decidedBy: null });
  });
});

describe("write-offs", () => {
  async function overdueDriver() {
    const d = await cashDriver();
    await h.c.db.paymentDue.create({ data: { beneficiaryAccountId: d.accountId, cycleEnd: new Date("2026-01-05"), amountMinor: 6900n, minimumMinor: 3450n, dueAt: new Date(h.clock.now - 1000) } });
    await h.c.payouts.overdueSweep();
    expect(await h.balanceOf("INDIVIDUAL", d.id)).toMatchObject({ state: "BLOCKED" });
    return d;
  }

  it("only debt overdue 90 days; the whole debt goes to bad debt and the dues close", async () => {
    const d = await overdueDriver();
    const fo = await h.financeOfficer();
    const fm = await h.financeManager();
    const tooSoon = await h.req("POST", "/api/payments/write-offs", fo, { accountId: d.accountId, reason: "driver left the platform" });
    expect(tooSoon.statusCode).toBe(400);
    expect(tooSoon.json()).toMatchObject({ error: "not_eligible" });
    // a debt that was never overdue is never eligible
    const clean = await cashDriver();

    h.clock.now += 91 * DAY;
    try {
      const cands = await h.ok<{ afterDays: number; candidates: Row[] }>(h.req("GET", "/api/payments/write-offs/candidates", fo));
      expect(cands.afterDays).toBe(90);
      expect(cands.candidates.find((c) => c.accountId === d.accountId)).toMatchObject({ balanceMinor: -6900, overdueDays: 91 });
      expect(cands.candidates.some((c) => c.accountId === clean.accountId)).toBe(false);

      const w = await h.ok<Row>(h.req("POST", "/api/payments/write-offs", fo, { accountId: d.accountId, reason: "driver left the platform" }), 201);
      expect(w).toMatchObject({ amountMinor: 6900, status: "PENDING_APPROVAL" });
      expect((await h.req("POST", "/api/payments/write-offs", fo, { accountId: d.accountId, reason: "asked a second time" })).json()).toMatchObject({ error: "already_requested" });
      expect((await h.req("POST", `/api/payments/write-offs/${w.id}/approve`, fo)).statusCode).toBe(403);

      const done = await h.ok<Row>(h.req("POST", `/api/payments/write-offs/${w.id}/approve`, fm));
      expect(done).toMatchObject({ status: "EXECUTED", balanceMinor: 0, state: "OK" });
      expect(await journalBalances(done.journalEntryId as string)).toEqual({ [`BENEFICIARY_BALANCE:INDIVIDUAL:${d.id}`]: 6900, BAD_DEBT_EXPENSE: -6900 });
      expect(await h.c.db.paymentDue.findMany({ where: { beneficiaryAccountId: d.accountId } })).toEqual([expect.objectContaining({ status: "WRITTEN_OFF" })]);
      expect((await h.outbox("balance.written_off")).map((o) => o.payload)).toContainEqual(expect.objectContaining({ writeOffId: w.id, amountMinor: 6900, balanceMinor: 0 }));
    } finally {
      h.clock.now -= 91 * DAY;
    }
  });

  it("approval refuses when the debt changed since the request", async () => {
    const d = await overdueDriver();
    const fo = await h.financeOfficer();
    const fm = await h.financeManager();
    h.clock.now += 91 * DAY;
    try {
      const w = await h.ok<Row>(h.req("POST", "/api/payments/write-offs", fo, { accountId: d.accountId, reason: "driver unreachable for months" }), 201);
      await h.c.payments.onTripCompleted(h.completed({ driverId: d.id, fareMinor: 40_000 })); // another cash trip: −69 more
      const r = await h.req("POST", `/api/payments/write-offs/${w.id}/approve`, fm);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: "balance_changed" });
      expect(await h.balanceOf("INDIVIDUAL", d.id)).toMatchObject({ balance: -13_800 });
    } finally {
      h.clock.now -= 91 * DAY;
    }
  });
});

describe("policy overrides", () => {
  it("a trusted driver gets larger limits for a window; the state follows approval, revocation and the window's end", async () => {
    const d = await cashDriver(400_000); // −690 ETB: below the city's cash limit (−500)
    expect(await h.balanceOf("INDIVIDUAL", d.id)).toMatchObject({ balance: -69_000, state: "CASH_BLOCKED" });
    const officer = await h.staff([{ r: "ONBOARDING_OFFICER", city: CITY }]);
    const fm = await h.financeManager();
    const until = new Date(h.clock.now + 30 * DAY).toISOString();

    const bad = await h.req("POST", "/api/payments/policy-overrides", officer, { accountId: d.accountId, cashLimitMinor: -150_000, validUntil: until, reason: "fleet partner vouches" });
    expect(bad.json()).toMatchObject({ error: "invalid_override" }); // below the city's hard limit
    const o = await h.ok<Row>(h.req("POST", "/api/payments/policy-overrides", officer, {
      accountId: d.accountId, cashLimitMinor: -150_000, hardLimitMinor: -200_000, validUntil: until, reason: "fleet partner vouches",
    }), 201);
    expect(o).toMatchObject({ status: "PENDING_APPROVAL", cashLimitMinor: -150_000, warningMinor: null, inForce: false });
    expect((await h.req("POST", `/api/payments/policy-overrides/${o.id}/approve`, officer)).statusCode).toBe(403);

    const approved = await h.ok<Row>(h.req("POST", `/api/payments/policy-overrides/${o.id}/approve`, fm));
    expect(approved).toMatchObject({ status: "APPROVED", inForce: true, state: "WARNING" });
    expect((await h.outbox("balance.state_changed")).map((x) => x.payload)).toContainEqual(expect.objectContaining({ accountId: d.accountId, state: "WARNING", previousState: "CASH_BLOCKED", cashAllowed: true }));
    const view = await h.ok<{ policy: { cashLimitMinor: number; override: { id: string } | null } }>(h.req("GET", `/api/payments/balances/${d.accountId}`, fm));
    expect(view.policy).toMatchObject({ cashLimitMinor: -150_000, override: { id: o.id } });

    // an overlapping one is refused when asked, and by the database
    expect((await h.req("POST", "/api/payments/policy-overrides", officer, { accountId: d.accountId, mode: "PREPAID", validUntil: until, reason: "another try at it" })).json()).toMatchObject({ error: "overlap" });
    await expect(h.c.db.policyOverride.create({
      data: { beneficiaryAccountId: d.accountId, cityId: CITY, mode: "PREPAID", validFrom: new Date(h.clock.now), validUntil: new Date(until), reason: "raw", status: "APPROVED", requestedBy: officer.id, decidedBy: fm.id, expiresAt: new Date(until) },
    })).rejects.toThrow();

    // revoked: the city's limits again
    expect((await h.req("POST", `/api/payments/policy-overrides/${o.id}/revoke`, fm, {})).statusCode).toBe(400); // a reason is required
    expect(await h.ok<Row>(h.req("POST", `/api/payments/policy-overrides/${o.id}/revoke`, fm, { reason: "the fleet partnership ended" }))).toMatchObject({ status: "REVOKED", state: "CASH_BLOCKED" });

    // a short window, asked by the reference code the driver quotes: the job recomputes the state when it closes
    const code = (await h.balanceOf("INDIVIDUAL", d.id))!.referenceCode;
    expect((await h.req("POST", "/api/payments/policy-overrides", officer, { accountId: d.accountId, referenceCode: code, mode: "PREPAID", validUntil: until, reason: "both ways at once" })).statusCode).toBe(400);
    const short = await h.ok<Row>(h.req("POST", "/api/payments/policy-overrides", officer, {
      referenceCode: code.toLowerCase(), cashLimitMinor: -150_000, hardLimitMinor: -200_000, validUntil: new Date(h.clock.now + DAY).toISOString(), reason: "one day of grace",
    }), 201);
    await h.ok(h.req("POST", `/api/payments/policy-overrides/${short.id}/approve`, fm));
    expect(await h.balanceOf("INDIVIDUAL", d.id)).toMatchObject({ state: "WARNING" });
    const since = new Date(h.clock.now);
    h.clock.now += 2 * DAY;
    try {
      expect(await h.c.policyOverrides.boundaries(since, new Date(h.clock.now))).toBeGreaterThanOrEqual(1);
      expect(await h.balanceOf("INDIVIDUAL", d.id)).toMatchObject({ state: "CASH_BLOCKED" });
    } finally {
      h.clock.now -= 2 * DAY;
    }
  });
});

describe("driver incentives", () => {
  const city = "incentive-test-city";

  it("proposed by operations, approved by finance, paid once at period close within the budget", async () => {
    const ops = await h.staff([{ r: "OPERATIONS_MANAGER", city }]);
    const fm = await h.financeManager();
    const start = h.clock.now;
    const program = {
      cityId: city, name: "Weekend rush", targetTrips: 3, rewardMinor: 30_000, budgetMinor: 60_000,
      startsAt: new Date(start - 1000).toISOString(), endsAt: new Date(start + 7 * DAY).toISOString(), reason: "more cars on Friday nights",
    };
    expect((await h.req("POST", "/api/payments/incentives", await h.staff([{ r: "OPERATIONS_MANAGER", city: "hawassa" }]), program)).statusCode).toBe(403);
    expect((await h.req("POST", "/api/payments/incentives", ops, { ...program, budgetMinor: 10_000 })).json()).toMatchObject({ error: "invalid_incentive" });
    const x = await h.ok<Row>(h.req("POST", "/api/payments/incentives", ops, program), 201);
    expect((await h.req("POST", `/api/payments/incentives/${x.id}/approve`, ops)).statusCode).toBe(403);
    expect(await h.ok<Row>(h.req("POST", `/api/payments/incentives/${x.id}/approve`, fm))).toMatchObject({ status: "APPROVED", decidedBy: fm.id });

    const a = uuid(), b = uuid(), c = uuid(), fleetDriver = uuid(), fleet = uuid();
    const trip = async (driverId: string, fleetOrgId?: string) => {
      h.clock.now += 60_000;
      await h.c.payments.onTripCompleted(h.completed({ driverId, fareMinor: 40_000, cityId: city, ...(fleetOrgId ? { fleetOrgId } : {}) }));
    };
    for (let i = 0; i < 3; i++) await trip(a); // a reaches 3 first
    for (let i = 0; i < 3; i++) await trip(fleetDriver, fleet); // then the fleet driver (paid to the fleet)
    for (let i = 0; i < 4; i++) await trip(b); // b reaches it last: over budget
    for (let i = 0; i < 2; i++) await trip(c); // c never reaches it

    const progress = await h.ok<{ progress: { driverId: string; trips: number; reached: boolean }[] }>(h.req("GET", `/api/payments/incentives/${x.id}`, ops));
    expect(progress.progress.find((r) => r.driverId === b)).toMatchObject({ trips: 4, reached: true });
    expect(await h.c.incentives.closeDue()).toBe(0); // still running

    h.clock.now = start + 7 * DAY + 1000;
    await trip(c); // after the window: doesn't count
    expect(await h.c.incentives.closeDue()).toBe(1);
    expect(await h.c.incentives.closeDue()).toBe(0);
    expect(await h.c.incentives.close(x.id)).toBeNull();

    const closed = await h.ok<Row & { awards: { driverId: string; accountId: string; amountMinor: number }[] }>(h.req("GET", `/api/payments/incentives/${x.id}`, fm));
    expect(closed).toMatchObject({ status: "CLOSED", qualifiedCount: 3, awardsCount: 2, spentMinor: 60_000 });
    expect(closed.awards.map((w) => w.driverId).sort()).toEqual([a, fleetDriver].sort());
    expect(await h.balanceOf("INDIVIDUAL", a)).toMatchObject({ balance: 3 * -6900 + 30_000 });
    expect(await h.balanceOf("INDIVIDUAL", b)).toMatchObject({ balance: 4 * -6900 });
    expect(await h.balanceOf("ORGANIZATION", fleet)).toMatchObject({ balance: 3 * -6900 + 30_000 });
    expect(await h.accountBalance(`PROMO_EXPENSE:${city}`)).toBe(-60_000);
    expect((await h.outbox("incentive.awarded")).filter((o) => (o.payload as { programId: string }).programId === x.id)).toHaveLength(2);

    // the driver's own view
    const driverA = await h.person([{ r: "DRIVER" }], a);
    const mine = await h.ok<{ incentives: Row[] }>(h.req("GET", `/api/payments/incentives/me?cityId=${city}`, driverA));
    expect(mine.incentives[0]).toMatchObject({ id: x.id, trips: 3, awardedMinor: 30_000, status: "CLOSED" });
  });
});

describe("corporate invoices", () => {
  it("finance issues a month once; the company admin sees only theirs; payments mark it paid; it never changes", async () => {
    const orgX = uuid(), orgY = uuid();
    const d = uuid();
    await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 40_000, paymentMethod: "CORPORATE", billingOrgId: orgX }));
    await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 25_000, paymentMethod: "CORPORATE", billingOrgId: orgX }));
    await h.c.payments.onTripCompleted(h.completed({ driverId: d, fareMinor: 10_000, paymentMethod: "CORPORATE", billingOrgId: orgY }));
    // postings carry the database's time; the month is the one they fall in
    const period = periodOf(new Date());
    const fo = await h.financeOfficer();
    const adminX = await h.person([{ r: "CORPORATE_ADMIN", org: orgX }]);

    const saved = h.clock.now;
    h.clock.now = Date.now();
    expect((await h.req("POST", "/api/payments/invoices", fo, { orgId: orgX, period })).json()).toMatchObject({ error: "period_open" });
    h.clock.now = addisMonth(period).end.getTime() + DAY;
    try {
      expect((await h.req("POST", "/api/payments/invoices", adminX, { orgId: orgX, period })).statusCode).toBe(403);
      const queue = await h.ok<{ companies: { orgId: string; totalMinor: number; lines: number }[] }>(h.req("GET", `/api/payments/invoices/uninvoiced?period=${period}`, fo));
      expect(queue.companies.find((x) => x.orgId === orgX)).toMatchObject({ totalMinor: 65_000, lines: 2 });

      const key = { "idempotency-key": `inv-${uuid()}` };
      const inv = await h.ok<Row & { number: string; lines: { tripId: string; amountMinor: number }[] }>(h.req("POST", "/api/payments/invoices", fo, { orgId: orgX, period }, key), 201);
      expect(inv).toMatchObject({ orgId: orgX, period, status: "ISSUED", totalMinor: 65_000, lineCount: 2, paidMinor: 0, outstandingMinor: 65_000 });
      expect(inv.number).toMatch(new RegExp(`^INV-${period.replace("-", "")}-\\d{5}$`));
      expect(inv.lines.map((l) => l.amountMinor)).toEqual([40_000, 25_000]);
      expect((await h.ok<Row>(h.req("POST", "/api/payments/invoices", fo, { orgId: orgX, period }, key), 201)).id).toBe(inv.id); // replay
      expect((await h.req("POST", "/api/payments/invoices", fo, { orgId: orgX, period })).json()).toMatchObject({ error: "already_issued" });
      const invY = await h.ok<Row & { number: string }>(h.req("POST", "/api/payments/invoices", fo, { orgId: orgY, period }), 201);
      expect(Number(invY.number.slice(-5))).toBe(Number(inv.number.slice(-5)) + 1); // gapless numbering
      expect((await h.ok<{ companies: { orgId: string }[] }>(h.req("GET", `/api/payments/invoices/uninvoiced?period=${period}`, fo))).companies.some((x) => x.orgId === orgX)).toBe(false);
      expect((await h.outbox("invoice.issued")).map((o) => o.payload)).toContainEqual(expect.objectContaining({ invoiceId: inv.id, totalMinor: 65_000, number: inv.number }));

      // the company admin: their invoices only
      const list = await h.ok<{ owedMinor: number; invoices: Row[] }>(h.req("GET", `/api/payments/org/${orgX}/invoices`, adminX));
      expect(list).toMatchObject({ owedMinor: 65_000, invoices: [expect.objectContaining({ id: inv.id })] });
      expect((await h.req("GET", `/api/payments/org/${orgY}/invoices`, adminX)).statusCode).toBe(403);
      expect((await h.req("GET", `/api/payments/org/${orgX}/invoices/${invY.id}`, adminX)).statusCode).toBe(404);
      expect((await h.req("GET", `/api/payments/invoices/${invY.id}`, adminX)).statusCode).toBe(404);
      expect((await h.req("GET", "/api/payments/invoices", adminX)).statusCode).toBe(403);
      const csv = await h.req("GET", `/api/payments/org/${orgX}/invoices/${inv.id}/csv`, adminX);
      expect(csv.headers["content-type"]).toMatch(/text\/csv/);
      expect(csv.body.split("\r\n")[0]).toBe("invoice_number,period,at,kind,trip_id,purpose,rider_id,city,vehicle_type,amount_etb");
      expect(csv.body).toContain(`${inv.number},${period},,TOTAL,,,,,,650.00`);

      // payments by bank transfer
      const pay = (amountMinor: number, bankReference: string) => h.req("POST", `/api/payments/invoices/${inv.id}/payments`, fo, { amountMinor, bankReference });
      expect(await h.ok<Row>(pay(40_000, "CBE-TX-1"), 201)).toMatchObject({ status: "ISSUED", paidMinor: 40_000, outstandingMinor: 25_000 });
      expect((await pay(1000, "cbe-tx-1")).json()).toMatchObject({ error: "duplicate_reference" });
      expect((await pay(30_000, "CBE-TX-2")).json()).toMatchObject({ error: "amount_exceeds_outstanding" });
      expect(await h.ok<Row>(pay(25_000, "CBE-TX-2"), 201)).toMatchObject({ status: "PAID", paidMinor: 65_000, outstandingMinor: 0 });
      expect((await pay(1000, "CBE-TX-3")).statusCode).toBe(409);
      expect(await h.accountBalance(`CORPORATE_RECEIVABLE:${orgX}`)).toBe(0);
      expect((await h.outbox("invoice.paid")).map((o) => o.payload)).toContainEqual(expect.objectContaining({ invoiceId: inv.id, paidMinor: 65_000 }));
      // a payment is not a charge: the month has nothing left to invoice for the company
      expect((await h.ok<{ companies: { orgId: string }[] }>(h.req("GET", `/api/payments/invoices/uninvoiced?period=${period}`, fo))).companies.some((x) => x.orgId === orgX)).toBe(false);

      // issued means issued
      await expect(h.c.db.$executeRaw`UPDATE invoice SET total_minor = 1 WHERE id = ${inv.id}::uuid`).rejects.toThrow();
      await expect(h.c.db.$executeRaw`DELETE FROM invoice_line WHERE invoice_id = ${inv.id}::uuid`).rejects.toThrow();
      await expect(h.c.db.$executeRaw`DELETE FROM invoice WHERE id = ${inv.id}::uuid`).rejects.toThrow();
    } finally {
      h.clock.now = saved;
    }
  });
});

describe("the ledger after all of it", () => {
  it("balances", async () => {
    const r = await integrity(h.c.db);
    expect(r).toMatchObject({ ok: true, totalMinor: 0, mismatched: [] });
  });
});
