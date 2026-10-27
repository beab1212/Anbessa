import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOLE, createHarness, HAWASSA, PIASSA, uuid, type Harness, type Who } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ops = (city = "addis-ababa") => h.staff([{ r: "OPERATIONS_MANAGER", city }]);
const marketing = (city = "addis-ababa") => h.staff([{ r: "MARKETING", city }]);
const finance = () => h.staff([{ r: "FINANCE_MANAGER", g: true }]);
const iso = (ms: number) => new Date(ms).toISOString();
const square = (c: { lat: number; lng: number }, d = 0.005): [number, number][] => [[c.lng - d, c.lat - d], [c.lng + d, c.lat - d], [c.lng + d, c.lat + d], [c.lng - d, c.lat + d]];

const estimate = (who: Who, body: object = {}) => h.req("POST", "/api/pricing/estimates", who, { pickup: BOLE, dropoff: PIASSA, vehicleTypes: ["economy"], ...body });
const economy = async (who: Who, body: object = {}) => {
  const r = await estimate(who, body);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<Json>();
};

describe("zones", () => {
  it("ops draws zones in their city; validation, scoping, versioning and audit", async () => {
    const om = await ops();
    const bad = await h.req("POST", "/api/pricing/zones", om, { cityId: "addis-ababa", name: "Bow tie", kind: "NO_PICKUP", polygon: [[38.79, 8.97], [38.80, 8.98], [38.80, 8.97], [38.79, 8.98]] });
    expect(bad.json()).toMatchObject({ error: "invalid_geometry" });
    expect((await h.req("POST", "/api/pricing/zones", om, { cityId: "addis-ababa", name: "Lake", kind: "NO_PICKUP", polygon: square(HAWASSA) })).json()).toMatchObject({ error: "invalid_geometry" });
    expect((await h.req("POST", "/api/pricing/zones", om, { cityId: "hawassa", name: "x", kind: "NO_PICKUP", polygon: square(HAWASSA) })).statusCode).toBe(403);
    expect((await h.req("POST", "/api/pricing/zones/check", om, { cityId: "addis-ababa", polygon: square(PIASSA) })).json()).toMatchObject({ valid: true, points: 4 });

    const key = { "idempotency-key": `zone-${uuid()}` };
    const body = { cityId: "addis-ababa", name: "Piassa market", kind: "NO_PICKUP", polygon: square(PIASSA, 0.002) };
    const a = await h.req("POST", "/api/pricing/zones", om, body, key);
    const b = await h.req("POST", "/api/pricing/zones", om, body, key);
    expect(a.statusCode, a.body).toBe(201);
    expect(b.json<Json>().zone.id).toBe(a.json<Json>().zone.id);
    const zone = a.json<Json>().zone;
    expect(zone).toMatchObject({ version: 1, kind: "NO_PICKUP", cityId: "addis-ababa" });
    expect(zone.polygon).toHaveLength(5);
    expect((await h.outbox("pricing.zone_changed")).some((e) => e.zoneId === zone.id && e.change === "CREATED" && e.zoneVersion === 1)).toBe(true);
    expect((await h.outbox("audit.recorded")).some((e) => e.action === "zone:manage" && (e.resource as Json).id === zone.id && e.service === "pricing-service")).toBe(true);

    const other = await ops("hawassa");
    expect((await h.req("GET", `/api/pricing/zones/${zone.id}`, other)).statusCode).toBe(404);
    expect((await h.req("GET", "/api/pricing/zones?cityId=addis-ababa", other)).statusCode).toBe(403);
    expect((await h.req("GET", "/api/pricing/zones", other)).json<Json>().zones).toEqual([]);
    expect((await h.req("GET", "/api/pricing/zones", await h.rider())).statusCode).toBe(403);
    expect((await h.req("GET", "/api/pricing/zones", om)).json<Json>().zones.map((z: Json) => z.id)).toContain(zone.id);

    const edited = await h.req("PUT", `/api/pricing/zones/${zone.id}`, om, { ...body, name: "Piassa (market days)", version: 1 });
    expect(edited.json<Json>().zone).toMatchObject({ version: 2, name: "Piassa (market days)" });
    expect((await h.req("PUT", `/api/pricing/zones/${zone.id}`, om, { ...body, version: 1 })).json()).toMatchObject({ error: "invalid_state" });

    // a pickup inside is refused; the drop-off may be inside
    const rider = await h.rider();
    expect((await h.req("POST", "/api/pricing/estimates", rider, { pickup: PIASSA, dropoff: BOLE })).json()).toMatchObject({ error: "pickup_not_allowed" });
    expect((await estimate(rider)).statusCode).toBe(200);

    expect((await h.req("DELETE", `/api/pricing/zones/${zone.id}`, om)).json<Json>().zone.archivedAt).not.toBeNull();
    expect((await h.req("POST", "/api/pricing/estimates", rider, { pickup: PIASSA, dropoff: BOLE })).statusCode).toBe(200);
  });

  it("an airport fee and a surge zone change the quote and are recorded on it", async () => {
    const om = await ops();
    const airport = (await h.req("POST", "/api/pricing/zones", om, { cityId: "addis-ababa", name: "Bole airport", kind: "AIRPORT", polygon: square(BOLE), feeMinor: 5000 })).json<Json>().zone;
    expect((await h.req("POST", "/api/pricing/zones", om, { cityId: "addis-ababa", name: "No fee", kind: "AIRPORT", polygon: square(BOLE) })).json()).toMatchObject({ error: "fee_required" });
    const surge = (await h.req("POST", "/api/pricing/zones", om, { cityId: "addis-ababa", name: "Bole rush", kind: "SURGE", polygon: square(BOLE, 0.003), surgeMultiplier: 1.5 })).json<Json>().zone;
    const q = (await economy(await h.rider())).quotes[0];
    // 170 birr × 1.5 = 255, + 50 airport
    expect(q).toMatchObject({ fareMinor: 30_500, breakdown: { surgeMultiplier: 1.5, zoneFeeMinor: 5000 }, fareRuleId: null });
    expect(q.zoneIds.sort()).toEqual([airport.id, surge.id].sort());
    await h.req("DELETE", `/api/pricing/zones/${airport.id}`, om);
    await h.req("DELETE", `/api/pricing/zones/${surge.id}`, om);
    expect((await economy(await h.rider())).quotes[0].fareMinor).toBe(17_000);
  });
});

describe("fare changes (maker–checker)", () => {
  it("propose → another ops manager approves → the rule takes over at validFrom; quotes keep their price", async () => {
    const maker = await ops();
    const checker = await ops();
    const card = { baseMinor: 6000, perKmMinor: 1500, perMinMinor: 200, minFareMinor: 8000, waitingPerMinMinor: 300 };
    expect((await h.req("POST", "/api/pricing/fare-changes", maker, { cityId: "addis-ababa", vehicleType: "economy", ...card, validFrom: iso(h.clock.now + HOUR), reason: "fuel" })).json()).toMatchObject({ error: "valid_from_too_soon" });
    expect((await h.req("POST", "/api/pricing/fare-changes", maker, { cityId: "hawassa", vehicleType: "economy", ...card, validFrom: iso(h.clock.now + 2 * DAY), reason: "fuel" })).statusCode).toBe(403);
    expect((await h.req("POST", "/api/pricing/fare-changes", maker, { cityId: "addis-ababa", vehicleType: "bajaj", ...card, validFrom: iso(h.clock.now + 2 * DAY), reason: "fuel" })).json()).toMatchObject({ error: "unknown_vehicle_type" });

    const preview = await h.req("POST", "/api/pricing/fare-changes/preview", maker, { cityId: "addis-ababa", vehicleType: "economy", ...card });
    expect(preview.json<Json>()).toMatchObject({ source: "SETTINGS" });
    expect(preview.json<Json>().impact.samples[0].deltaMinor).toBe(1000);

    const validFrom = h.clock.now + 2 * DAY;
    const res = await h.req("POST", "/api/pricing/fare-changes", maker, { cityId: "addis-ababa", vehicleType: "economy", ...card, validFrom: iso(validFrom), reason: "fuel price up" }, { "idempotency-key": `fc-${uuid()}` });
    expect(res.statusCode, res.body).toBe(201);
    const change = res.json<Json>().change;
    expect(change).toMatchObject({ status: "PENDING", phase: "PENDING", makerId: maker.id, impact: { current: { baseMinor: 5000 } } });
    expect((await h.req("POST", "/api/pricing/fare-changes", checker, { cityId: "addis-ababa", vehicleType: "economy", ...card, validFrom: iso(validFrom + DAY), reason: "again" })).json()).toMatchObject({ error: "already_pending" });
    expect((await h.outbox("audit.recorded")).some((e) => e.action === "pricing:propose" && e.outcome === "PENDING_APPROVAL" && (e.resource as Json).id === change.id)).toBe(true);

    expect((await h.req("GET", `/api/pricing/fare-changes/${change.id}`, await ops("hawassa"))).statusCode).toBe(404);
    expect((await h.req("POST", `/api/pricing/fare-changes/${change.id}/approve`, maker, {})).json()).toMatchObject({ error: "maker_is_checker" });
    expect((await h.req("POST", `/api/pricing/fare-changes/${change.id}/approve`, await marketing(), {})).statusCode).toBe(404);

    const before = (await economy(await h.rider())).quotes[0];
    const approved = await h.req("POST", `/api/pricing/fare-changes/${change.id}/approve`, checker, { reason: "ok" });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<Json>().change).toMatchObject({ status: "APPROVED", phase: "SCHEDULED", checkerId: checker.id });
    const ruleId = approved.json<Json>().change.ruleId;
    expect((await h.outbox("pricing.rule_scheduled")).some((e) => e.ruleId === ruleId && e.validFrom === iso(validFrom) && e.approvedBy === checker.id)).toBe(true);

    // not yet: settings still apply
    expect((await economy(await h.rider())).quotes[0]).toMatchObject({ fareMinor: 17_000, fareRuleId: null });
    const overview = (await h.req("GET", "/api/pricing/fare-rules?cityId=addis-ababa", maker)).json<Json>();
    const eco = overview.fares.find((f: Json) => f.vehicleType === "economy");
    expect(eco.current).toMatchObject({ source: "SETTINGS" });
    expect(eco.scheduled.map((r: Json) => r.id)).toEqual([ruleId]);

    h.clock.now = validFrom + 1000;
    expect(await h.c.rules.sweep()).toMatchObject({ activated: 1 });
    expect((await h.outbox("pricing.rule_activated")).some((e) => e.ruleId === ruleId)).toBe(true);
    const after = (await economy(await h.rider())).quotes[0];
    expect(after).toMatchObject({ fareMinor: 18_000, fareRuleId: ruleId });
    expect((await h.req("GET", "/api/pricing/fares?cityId=addis-ababa", null)).json<Json>().fares.find((f: Json) => f.vehicleType === "economy")).toMatchObject({ baseMinor: 6000 });
    // the quote issued before keeps its price
    expect((await h.internal(`/internal/quotes/${before.id}`)).json<Json>().fareMinor).toBe(17_000);
    // other cities are untouched
    expect((await h.req("POST", "/api/pricing/estimates", await h.rider(), { pickup: HAWASSA, dropoff: { lat: 7.06, lng: 38.48 }, vehicleTypes: ["economy"] })).json<Json>().quotes[0].fareRuleId).toBeNull();
  });

  it("emergency changes apply on approval (finance can approve); reject, withdraw and expiry", async () => {
    const maker = await ops();
    const card = { baseMinor: 6000, perKmMinor: 1400, perMinMinor: 200, minFareMinor: 8000, waitingPerMinMinor: 300 };
    const c1 = (await h.req("POST", "/api/pricing/fare-changes", maker, { cityId: "addis-ababa", vehicleType: "economy", ...card, emergency: true, reason: "wrong per km" })).json<Json>().change;
    const fm = await finance();
    const ok = await h.req("POST", `/api/pricing/fare-changes/${c1.id}/approve`, fm, {});
    expect(ok.json<Json>().change).toMatchObject({ status: "APPROVED", phase: "APPROVED", emergency: true });
    expect((await h.outbox("pricing.rule_activated")).some((e) => e.ruleId === ok.json<Json>().change.ruleId)).toBe(true);
    // 60 + 84 + 30 = 174
    expect((await economy(await h.rider())).quotes[0]).toMatchObject({ fareMinor: 17_400, fareRuleId: ok.json<Json>().change.ruleId });

    const c2 = (await h.req("POST", "/api/pricing/fare-changes", maker, { cityId: "addis-ababa", vehicleType: "comfort", ...card, validFrom: iso(h.clock.now + 3 * DAY), reason: "align" })).json<Json>().change;
    expect((await h.req("POST", `/api/pricing/fare-changes/${c2.id}/reject`, maker, { reason: "mine" })).json()).toMatchObject({ error: "maker_is_checker" });
    expect((await h.req("POST", `/api/pricing/fare-changes/${c2.id}/reject`, await ops(), { reason: "too high" })).json<Json>().change).toMatchObject({ status: "REJECTED", decisionReason: "too high" });

    const c3 = (await h.req("POST", "/api/pricing/fare-changes", maker, { cityId: "addis-ababa", vehicleType: "comfort", ...card, validFrom: iso(h.clock.now + 3 * DAY), reason: "align" })).json<Json>().change;
    expect((await h.req("POST", `/api/pricing/fare-changes/${c3.id}/cancel`, await ops(), {})).statusCode).toBe(403);
    expect((await h.req("POST", `/api/pricing/fare-changes/${c3.id}/cancel`, maker, {})).json<Json>().change.status).toBe("CANCELLED");

    const c4 = (await h.req("POST", "/api/pricing/fare-changes", maker, { cityId: "addis-ababa", vehicleType: "minivan", ...card, validFrom: iso(h.clock.now + 2 * DAY), reason: "align" })).json<Json>().change;
    h.clock.now += 8 * DAY;
    expect((await h.c.rules.sweep()).expired).toBeGreaterThanOrEqual(1);
    expect((await h.req("GET", `/api/pricing/fare-changes/${c4.id}`, maker)).json<Json>().change.status).toBe("EXPIRED");
    const list = (await h.req("GET", "/api/pricing/fare-changes?cityId=addis-ababa&limit=50", maker)).json<Json>().changes as Json[];
    expect(list.map((c) => c.id)).toEqual(expect.arrayContaining([c1.id, c2.id, c3.id, c4.id]));
  });
});

describe("promos", () => {
  const promo = (over: object = {}) => ({
    code: `RIDE${Math.floor(Math.random() * 1e6)}`, name: "Twenty off", type: "PERCENT_OFF", percentOff: 20, maxDiscountMinor: 5000,
    cityIds: ["addis-ababa"], vehicleTypes: ["economy"], startsAt: iso(h.clock.now - HOUR), endsAt: iso(h.clock.now + 30 * DAY),
    perUserLimit: 1, budgetMinor: 6000, ...over,
  });

  it("marketing creates and activates a small promo; riders get a discounted quote; completion redeems it until the budget runs out", async () => {
    const mk = await marketing();
    expect((await h.req("POST", "/api/pricing/promos", await marketing("hawassa"), promo())).statusCode).toBe(403);
    expect((await h.req("POST", "/api/pricing/promos", mk, promo({ cityIds: [] }))).statusCode).toBe(403);
    const created = await h.req("POST", "/api/pricing/promos", mk, promo(), { "idempotency-key": `promo-${uuid()}` });
    expect(created.statusCode, created.body).toBe(201);
    const p = created.json<Json>().promo;
    expect(p).toMatchObject({ status: "DRAFT", needsFinanceApproval: false });
    expect((await h.req("POST", "/api/pricing/promos", mk, promo({ code: p.code.toLowerCase() }))).json()).toMatchObject({ error: "code_taken" });

    // a draft code doesn't exist for riders
    const r1 = await h.rider();
    expect((await economy(r1, { promoCode: p.code })).promo).toMatchObject({ applied: false, reason: "unknown_code" });

    const act = await h.req("POST", `/api/pricing/promos/${p.id}/activate`, mk);
    expect(act.json<Json>().promo).toMatchObject({ status: "ACTIVE", activatedBy: mk.id });
    expect((await h.outbox("promo.activated")).some((e) => e.promoId === p.id)).toBe(true);
    expect((await h.req("GET", `/api/pricing/promos/${p.id}`, await marketing("hawassa"))).statusCode).toBe(404);

    expect((await h.req("POST", "/api/pricing/promos/check", r1, { code: p.code.toLowerCase(), pickup: BOLE })).json()).toMatchObject({ valid: true, promo: { code: p.code, percentOff: 20 } });
    expect((await h.req("POST", "/api/pricing/promos/check", r1, { code: p.code, pickup: HAWASSA })).json()).toMatchObject({ valid: false, reason: "not_in_city" });

    // the emergency rule above is in force: 174 birr; 20% = 34.80 → 34 (whole birr)
    const est = await economy(r1, { promoCode: p.code.toLowerCase(), vehicleTypes: ["economy", "comfort"] });
    expect(est.promo).toMatchObject({ applied: true, discountedQuotes: 1 });
    const [eco, comfort] = est.quotes;
    expect(eco).toMatchObject({ fareMinor: 17_400, discountMinor: 3400, payableMinor: 14_000, promo: { promoId: p.id, code: p.code, discountMinor: 3400 } });
    expect(comfort).toMatchObject({ discountMinor: 0 });
    expect(comfort.promo).toBeUndefined();

    // trip-service books with it, the trip completes
    const booked = await h.internal(`/internal/quotes/${eco.id}`);
    expect(booked.json<Json>()).toMatchObject({ discountMinor: 3400, promo: { promoId: p.id } });
    expect((await h.c.db.promoReservation.findUniqueOrThrow({ where: { quoteId: eco.id } })).status).toBe("BOOKED");
    expect((await h.req("GET", `/api/pricing/promos/${p.id}`, mk)).json<Json>().promo).toMatchObject({ bookedMinor: 3400, bookedCount: 1 });
    const trip1 = uuid();
    const done = { tripId: trip1, riderId: r1.id, cityId: "addis-ababa", vehicleType: "economy", fareMinor: 17_400, currency: "ETB", completedAt: iso(h.clock.now + HOUR) };
    await h.consumer.handle("trip.completed", JSON.stringify(done));
    await h.consumer.handle("trip.completed", JSON.stringify(done)); // replay: once
    expect((await h.outbox("promo.redeemed")).filter((e) => e.tripId === trip1)).toEqual([expect.objectContaining({ promoId: p.id, discountMinor: 3400, riderId: r1.id, quoteId: eco.id })]);
    expect((await h.req("GET", `/api/pricing/promos/${p.id}`, mk)).json<Json>().promo).toMatchObject({ spentMinor: 3400, redemptionCount: 1, bookedMinor: 0, status: "ACTIVE" });

    // once per rider
    expect((await economy(r1, { promoCode: p.code })).promo).toMatchObject({ applied: false, reason: "limit_reached" });

    // the next rider gets what's left of the budget (26 birr), which exhausts it
    const r2 = await h.rider();
    const q2 = (await economy(r2, { promoCode: p.code })).quotes[0];
    expect(q2.discountMinor).toBe(2600);
    await h.internal(`/internal/quotes/${q2.id}`);
    await h.consumer.handle("trip.completed", JSON.stringify({ ...done, tripId: uuid(), riderId: r2.id, quoteId: q2.id }));
    expect((await h.req("GET", `/api/pricing/promos/${p.id}`, mk)).json<Json>().promo).toMatchObject({ spentMinor: 6000, redemptionCount: 2, status: "EXHAUSTED" });
    expect((await h.outbox("promo.exhausted")).some((e) => e.promoId === p.id)).toBe(true);
    expect((await economy(await h.rider(), { promoCode: p.code })).promo).toMatchObject({ applied: false, reason: "exhausted" });
    expect((await h.req("GET", `/api/pricing/promos/${p.id}/redemptions`, mk)).json<Json>().redemptions).toHaveLength(2);
  });

  it("a big budget needs a finance manager who isn't the creator; cancelled trips give the discount back", async () => {
    const mk = await marketing();
    const p = (await h.req("POST", "/api/pricing/promos", mk, promo({ type: "AMOUNT_OFF", percentOff: null, amountOffMinor: 2000, maxDiscountMinor: null, budgetMinor: 5_000_000, vehicleTypes: [] }))).json<Json>().promo;
    expect(p.needsFinanceApproval).toBe(true);
    expect((await h.req("POST", `/api/pricing/promos/${p.id}/activate`, mk)).json()).toMatchObject({ error: "approval_required" });
    const fm = await finance();
    expect((await h.req("GET", "/api/pricing/promos?status=DRAFT", fm)).json<Json>().promos.map((x: Json) => x.id)).toContain(p.id);
    expect((await h.req("POST", `/api/pricing/promos/${p.id}/activate`, fm)).json<Json>().promo).toMatchObject({ status: "ACTIVE", activatedBy: fm.id });
    expect((await h.outbox("audit.recorded")).some((e) => e.action === "incentive:approve" && (e.resource as Json).id === p.id)).toBe(true);

    const rider = await h.rider();
    const q = (await economy(rider, { promoCode: p.code })).quotes[0];
    expect(q).toMatchObject({ fareMinor: 17_400, discountMinor: 2000, payableMinor: 15_400 });
    await h.internal(`/internal/quotes/${q.id}`);
    await h.consumer.handle("trip.cancelled", JSON.stringify({ tripId: uuid(), riderId: rider.id, cityId: "addis-ababa" }));
    expect((await h.c.db.promoReservation.findUniqueOrThrow({ where: { quoteId: q.id } })).status).toBe("RELEASED");
    // released: the rider can use it again
    expect((await economy(rider, { promoCode: p.code })).promo).toMatchObject({ applied: true });

    // paused: the quote already issued is served without the discount
    const q2 = (await economy(await h.rider(), { promoCode: p.code })).quotes[0];
    expect((await h.req("POST", `/api/pricing/promos/${p.id}/pause`, mk)).json<Json>().promo.status).toBe("PAUSED");
    const served = (await h.internal(`/internal/quotes/${q2.id}`)).json<Json>();
    expect(served).toMatchObject({ discountMinor: 0, payableMinor: served.fareMinor });
    expect(served.promo).toBeUndefined();
    expect((await economy(await h.rider(), { promoCode: p.code })).promo).toMatchObject({ applied: false, reason: "not_active" });
    expect((await h.req("POST", `/api/pricing/promos/${p.id}/resume`, mk)).json<Json>().promo.status).toBe("ACTIVE");
    expect((await h.req("PUT", `/api/pricing/promos/${p.id}`, mk, promo())).json()).toMatchObject({ error: "not_draft" });

    // the end date passes
    h.clock.now += 31 * DAY;
    expect((await h.c.promos.sweep()).promosExpired).toBeGreaterThanOrEqual(1);
    expect((await h.req("GET", `/api/pricing/promos/${p.id}`, mk)).json<Json>().promo.status).toBe("EXPIRED");
    expect((await h.req("POST", `/api/pricing/promos/${p.id}/archive`, mk)).json<Json>().promo.status).toBe("ARCHIVED");
  });

  it("trip-service's events name the quote: redemption uses the discount it applied, cancellation releases that quote's reservation", async () => {
    const mk = await marketing();
    const p = (await h.req("POST", "/api/pricing/promos", mk, promo({ type: "AMOUNT_OFF", percentOff: null, amountOffMinor: 2000, maxDiscountMinor: null, budgetMinor: 20_000, perUserLimit: 3 }))).json<Json>().promo;
    await h.req("POST", `/api/pricing/promos/${p.id}/activate`, mk);
    const rider = await h.rider();

    // two booked quotes of the same rider: the event's quoteId picks the right one
    const qa = (await economy(rider, { promoCode: p.code })).quotes[0];
    const qb = (await economy(rider, { promoCode: p.code })).quotes[0];
    await h.internal(`/internal/quotes/${qa.id}`);
    await h.internal(`/internal/quotes/${qb.id}`);
    await h.consumer.handle("trip.cancelled", JSON.stringify({ tripId: uuid(), riderId: rider.id, cityId: "addis-ababa", quoteId: qa.id }));
    expect((await h.c.db.promoReservation.findUniqueOrThrow({ where: { quoteId: qa.id } })).status).toBe("RELEASED");
    expect((await h.c.db.promoReservation.findUniqueOrThrow({ where: { quoteId: qb.id } })).status).toBe("BOOKED");

    // completed with the discount trip-service applied (capped by the final fare there)
    const tripId = uuid();
    await h.consumer.handle("trip.completed", JSON.stringify({
      tripId, riderId: rider.id, cityId: "addis-ababa", vehicleType: "economy", fareMinor: 18_000, currency: "ETB", completedAt: iso(h.clock.now + HOUR),
      quoteId: qb.id, promoDiscountMinor: 1500,
    }));
    expect((await h.outbox("promo.redeemed")).filter((e) => e.tripId === tripId)).toEqual([expect.objectContaining({ quoteId: qb.id, fareMinor: 18_000, discountMinor: 1500 })]);
    expect((await h.c.db.promoReservation.findUniqueOrThrow({ where: { quoteId: qb.id } })).status).toBe("REDEEMED");
    expect((await h.req("GET", `/api/pricing/promos/${p.id}`, mk)).json<Json>().promo).toMatchObject({ spentMinor: 1500, redemptionCount: 1, bookedMinor: 0 });
  });

  it("invalid trip events are skipped", async () => {
    await expect(h.consumer.handle("trip.completed", "not json")).resolves.toBeUndefined();
    await expect(h.consumer.handle("trip.completed", JSON.stringify({ tripId: "x" }))).resolves.toBeUndefined();
  });
});
