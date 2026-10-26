import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BOLE, CITY, createHarness, near, PIASSA, uuid, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());
beforeEach(async () => {
  await h.redis.flushdb(); // this suite's own Redis container only
  h.pushes.length = 0;
  h.mappingState.down = false;
  h.clock.now = Date.now();
});

const outbox = (tripId: string, topic: string) =>
  h.c.db.outbox.findMany({ where: { key: tripId, topic } }).then((rows) => rows.map((r) => r.payload as Record<string, unknown>));

describe("request (workflow 05, part C)", () => {
  it("creates a requested trip from the quote, with the PIN for the rider only", async () => {
    const r = await h.rider();
    const q = await h.quote(r);
    const res = await h.req("POST", "/api/trips", r, { quoteId: q.id, paymentMethod: "CASH" });
    expect(res.statusCode).toBe(201);
    const trip = res.json<{ id: string; status: string; pin: string; fare: { estimateMinor: number }; channel: string }>();
    expect(trip).toMatchObject({ status: "requested", channel: "APP", fare: { estimateMinor: q.fareMinor } });
    expect(trip.pin).toMatch(/^\d{4}$/);
    const [event] = await outbox(trip.id, "trip.requested");
    expect(event).toMatchObject({ tripId: trip.id, riderId: r.id, paymentMethod: "CASH", eventId: expect.any(String), version: 1 });
  });

  it("the same Idempotency-Key returns the same trip; a different body with it is refused", async () => {
    const r = await h.rider();
    const q = await h.quote(r);
    const headers = { "idempotency-key": `key-${uuid()}` };
    const a = await h.req("POST", "/api/trips", r, { quoteId: q.id, paymentMethod: "CASH" }, headers);
    const b = await h.req("POST", "/api/trips", r, { quoteId: q.id, paymentMethod: "CASH" }, headers);
    expect(b.statusCode).toBe(201);
    expect(b.json<{ id: string }>().id).toBe(a.json<{ id: string }>().id);
    const c = await h.req("POST", "/api/trips", r, { quoteId: q.id, paymentMethod: "CARD" }, headers);
    expect(c.statusCode).toBe(422);
  });

  it("one active trip per rider (database-enforced)", async () => {
    const r = await h.rider();
    expect((await h.requestTrip(r)).statusCode).toBe(201);
    const second = await h.requestTrip(r);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "active_trip_exists" });
  });

  it("refuses expired quotes and other people's quotes", async () => {
    const r = await h.rider();
    const q = await h.quote(r);
    const other = await h.rider();
    expect((await h.req("POST", "/api/trips", other, { quoteId: q.id, paymentMethod: "CASH" })).json()).toMatchObject({ error: "invalid_quote" });
    h.clock.now += 11 * 60_000;
    expect((await h.req("POST", "/api/trips", r, { quoteId: q.id, paymentMethod: "CASH" })).statusCode).toBe(400);
  });

  it("booking for someone else: call center by phone, coordinators on the corporate account only", async () => {
    const guest = uuid();
    const agent = await h.staff([{ r: "CALL_CENTER_AGENT", city: CITY }]);
    const q = await h.quote(agent);
    const phone = await h.req("POST", "/api/trips", agent, { quoteId: q.id, paymentMethod: "CASH", riderUserId: guest });
    expect(phone.statusCode).toBe(201);
    expect(phone.json()).toMatchObject({ channel: "PHONE", riderUserId: guest });

    const elsewhere = await h.staff([{ r: "CALL_CENTER_AGENT", city: "hawassa" }]);
    const q2 = await h.quote(elsewhere);
    expect((await h.req("POST", "/api/trips", elsewhere, { quoteId: q2.id, paymentMethod: "CASH", riderUserId: uuid() })).statusCode).toBe(403);

    const org = uuid();
    const coordinator = await h.rider(uuid(), [{ r: "CORPORATE_COORDINATOR", org }]);
    const q3 = await h.quote(coordinator);
    const corp = await h.req("POST", "/api/trips", coordinator, { quoteId: q3.id, paymentMethod: "CORPORATE", billingOrgId: org, riderUserId: uuid() });
    expect(corp.statusCode).toBe(201);
    expect(corp.json()).toMatchObject({ channel: "CORPORATE_PORTAL", billing: { type: "CORPORATE", orgId: org } });

    const plainRider = await h.rider();
    const q4 = await h.quote(plainRider);
    expect((await h.req("POST", "/api/trips", plainRider, { quoteId: q4.id, paymentMethod: "CASH", riderUserId: uuid() })).statusCode).toBe(400);
  });

  it("only employees of the company may bill it", async () => {
    const org = uuid();
    const employee = await h.rider(uuid(), [{ r: "RIDER" }, { r: "CORPORATE_EMPLOYEE", org }]);
    expect((await h.requestTrip(employee, { paymentMethod: "CORPORATE", billingOrgId: org })).statusCode).toBe(201);
    const outsider = await h.rider();
    expect((await h.requestTrip(outsider, { paymentMethod: "CORPORATE", billingOrgId: org })).statusCode).toBe(403);
    expect((await h.requestTrip(outsider, { paymentMethod: "CORPORATE" })).statusCode).toBe(400);
  });
});

describe("matching (workflow 05, parts D–E)", () => {
  it("offers the nearest driver by driving time, who accepts", async () => {
    const far = await h.driver(near(BOLE, 1500));
    const close = await h.driver(near(BOLE, 200));
    const r = await h.rider();
    const tripId = (await h.requestTrip(r)).json<{ id: string }>().id;
    const offer = await h.offerFor(tripId);
    expect(offer?.driverUserId).toBe(close.id);
    expect(h.pushes.find((p) => p.event === "trip:offer")).toMatchObject({ userId: close.id, payload: { tripId, offerId: offer!.id } });

    // someone else can't use the offer
    expect((await h.req("POST", `/api/trips/${tripId}/accept`, far, { offerId: offer!.id })).statusCode).toBe(404);
    const acc = await h.req("POST", `/api/trips/${tripId}/accept`, close, { offerId: offer!.id });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ status: "matched", driver: { userId: close.id } });
    expect(acc.json()).not.toHaveProperty("pin"); // the driver asks the rider for it
    const [event] = await outbox(tripId, "trip.matched");
    expect(event).toMatchObject({ tripId, riderId: r.id, driverId: close.id, cityId: CITY, vehicleType: "economy" });
    expect(h.pushes.some((p) => p.userId === r.id && p.event === "trip:status" && p.payload.status === "matched")).toBe(true);
  });

  it("a decline moves to the next driver; an expired offer too", async () => {
    const a = await h.driver(near(BOLE, 100));
    const b = await h.driver(near(BOLE, 400));
    const c = await h.driver(near(BOLE, 800));
    const tripId = (await h.requestTrip(await h.rider())).json<{ id: string }>().id;
    const first = await h.offerFor(tripId);
    expect(first?.driverUserId).toBe(a.id);
    await h.req("POST", `/api/trips/${tripId}/decline`, a, { offerId: first!.id });
    const second = await h.offerFor(tripId);
    expect(second?.driverUserId).toBe(b.id);

    h.clock.now += 16_000;
    await c.ping(); // keep the remaining driver fresh
    const third = await h.offerFor(tripId);
    expect(third?.driverUserId).toBe(c.id);
    expect((await h.c.db.tripOffer.findUniqueOrThrow({ where: { id: second!.id } })).status).toBe("EXPIRED");
  });

  it("cash trips skip drivers who can't take cash", async () => {
    await h.driver(near(BOLE, 100), { cashAllowed: false });
    const ok = await h.driver(near(BOLE, 500));
    const tripId = (await h.requestTrip(await h.rider(), { paymentMethod: "CASH" })).json<{ id: string }>().id;
    expect((await h.offerFor(tripId))?.driverUserId).toBe(ok.id);
  });

  it("drivers whose balance is blocked get no trips at all", async () => {
    await h.driver(near(BOLE, 100), { cashAllowed: false, balanceState: "BLOCKED" });
    const ok = await h.driver(near(BOLE, 500));
    const tripId = (await h.requestTrip(await h.rider(), { paymentMethod: "CARD" })).json<{ id: string }>().id;
    expect((await h.offerFor(tripId))?.driverUserId).toBe(ok.id);
  });

  it("refuses payment methods turned off in the city (Settings → Payments)", async () => {
    h.settings.set("payments.methods", ["CASH", "MOBILE_MONEY"], "addis-ababa");
    const r = await h.requestTrip(await h.rider(), { paymentMethod: "CARD" });
    expect(r.json()).toMatchObject({ error: "payment_method_unavailable" });
    h.settings.set("payments.methods", ["CASH", "MOBILE_MONEY", "CARD"], "addis-ababa");
  });

  it("ranks by distance when mapping-service is down", async () => {
    h.mappingState.down = true;
    const close = await h.driver(near(BOLE, 150));
    await h.driver(near(BOLE, 900));
    const tripId = (await h.requestTrip(await h.rider())).json<{ id: string }>().id;
    expect((await h.offerFor(tripId))?.driverUserId).toBe(close.id);
  });

  it("no driver within 120 s → cancelled NO_DRIVER_FOUND, free", async () => {
    const tripId = (await h.requestTrip(await h.rider())).json<{ id: string }>().id;
    expect(await h.offerFor(tripId)).toBeNull();
    h.clock.now += 121_000;
    await h.c.matcher.step(tripId);
    const t = await h.c.db.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(t).toMatchObject({ status: "cancelled", cancelledBy: "SYSTEM", cancelReason: "NO_DRIVER_FOUND", cancelFeeMinor: 0n });
  });

  it("the rider cancelling first wins over a late accept", async () => {
    const d = await h.driver();
    const r = await h.rider();
    const tripId = (await h.requestTrip(r)).json<{ id: string }>().id;
    const offer = await h.offerFor(tripId);
    expect((await h.req("POST", `/api/trips/${tripId}/cancel`, r, { reason: "CHANGED_PLANS" })).statusCode).toBe(200);
    const acc = await h.req("POST", `/api/trips/${tripId}/accept`, d, { offerId: offer!.id });
    expect(acc.statusCode).toBe(409);
    expect(h.pushes.some((p) => p.userId === d.id && p.event === "trip:offer_cancelled")).toBe(true);
  });

  it("a driver can't hold two active trips (database-enforced), even through a dispatcher", async () => {
    const { d } = await h.matchedTrip({ simulateLocation: false });
    const other = (await h.requestTrip(await h.rider())).json<{ id: string }>().id;
    const dispatcher = await h.staff([{ r: "DISPATCHER", city: CITY }]);
    // the driver is still "available" in Redis here (location-service would mark them on_trip)
    const res = await h.req("POST", `/api/trips/${other}/assign`, dispatcher, { driverId: d.id });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "driver_busy" });
  });

  it("dispatchers assign manually in their city only", async () => {
    const d = await h.driver();
    const tripId = (await h.requestTrip(await h.rider())).json<{ id: string }>().id;
    const other = await h.staff([{ r: "DISPATCHER", city: "hawassa" }]);
    expect((await h.req("POST", `/api/trips/${tripId}/assign`, other, { driverId: d.id })).statusCode).toBe(403);
    const dispatcher = await h.staff([{ r: "DISPATCHER", city: CITY }]);
    expect((await h.req("POST", `/api/trips/${tripId}/assign`, dispatcher, { driverId: d.id })).json()).toMatchObject({ status: "matched" });
  });
});

describe("execution (workflow 06)", () => {
  it("en route → arrive (geofenced) → start → complete, with paid waiting and the payment facts", async () => {
    const fleetOrgId = uuid();
    const { r, d, tripId } = await h.matchedTrip({ driverOpts: { fleetOrgId } });
    const post = (path: string, body?: object) => h.req("POST", `/api/trips/${tripId}/${path}`, d, body);

    expect((await h.req("POST", `/api/trips/${tripId}/en-route`, r)).statusCode).toBe(404); // riders can't drive the trip
    expect((await post("arrive")).json()).toMatchObject({ error: "invalid_state" });
    expect((await post("en-route")).json()).toMatchObject({ status: "en_route" });
    expect((await post("start")).json()).toMatchObject({ error: "not_arrived" });

    await d.ping(near(BOLE, 400));
    expect((await post("arrive")).json()).toMatchObject({ error: "too_far_from_pickup" });
    await d.ping(near(BOLE, 60));
    expect((await post("arrive")).json()).toMatchObject({ status: "en_route", times: { arrivedAt: expect.any(String) } });

    h.clock.now += 5 * 60_000 + 10_000; // 2 min 10 s of paid waiting → 3 started minutes
    expect((await post("start")).json()).toMatchObject({ status: "in_progress" });
    h.clock.now += 15 * 60_000;
    await d.ping(near(PIASSA, 50));
    const done = (await post("complete")).json<{ status: string; fare: { estimateMinor: number; finalMinor: number; waitingFeeMinor: number } }>();
    expect(done.status).toBe("completed");
    expect(done.fare.waitingFeeMinor).toBe(3 * 300);
    expect(done.fare.finalMinor).toBe(done.fare.estimateMinor + 900);

    const [event] = await outbox(tripId, "trip.completed");
    expect(event).toMatchObject({
      tripId, riderId: r.id, driverId: d.id, beneficiary: { type: "ORGANIZATION", id: fleetOrgId },
      paymentMethod: "MOBILE_MONEY", fareMinor: done.fare.finalMinor, waitingFeeMinor: 900, currency: "ETB",
    });
    // duration = start → completion (15 min plus the simulated drive to Piassa)
    const row = await h.c.db.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(event!.durationSeconds).toBe(Math.round((row.completedAt!.getTime() - row.startedAt!.getTime()) / 1000));
    expect(event!.durationSeconds as number).toBeGreaterThanOrEqual(900);
    expect(await h.c.db.driverActiveTrip.findUnique({ where: { driverUserId: d.id } })).toBeNull();
    const history = await h.c.db.tripEvent.findMany({ where: { tripId }, orderBy: { at: "asc" } });
    expect(history.map((e) => e.toStatus)).toEqual(["requested", "matched", "en_route", "en_route", "in_progress", "completed"]);
  });

  it("completing far from the drop-off is flagged for review (staff see it)", async () => {
    const { d, tripId } = await h.matchedTrip();
    for (const s of ["en-route"]) await h.req("POST", `/api/trips/${tripId}/${s}`, d);
    await d.ping(near(BOLE, 20));
    await h.req("POST", `/api/trips/${tripId}/arrive`, d);
    await h.req("POST", `/api/trips/${tripId}/start`, d);
    h.clock.now += 60_000;
    await d.ping(near(BOLE, 900)); // nowhere near Piassa
    await h.req("POST", `/api/trips/${tripId}/complete`, d);
    const support = await h.staff([{ r: "SUPPORT_AGENT", city: CITY }]);
    expect((await h.req("GET", `/api/trips/${tripId}`, support)).json()).toMatchObject({ flags: ["FAR_FROM_DROPOFF"] });
  });

  it("ratings: once each, only after completion", async () => {
    const { r, d, tripId } = await h.matchedTrip();
    expect((await h.req("POST", `/api/trips/${tripId}/rating`, r, { stars: 5 })).statusCode).toBe(409);
    await h.req("POST", `/api/trips/${tripId}/en-route`, d);
    await d.ping(near(BOLE, 10));
    await h.req("POST", `/api/trips/${tripId}/arrive`, d);
    await h.req("POST", `/api/trips/${tripId}/start`, d);
    await h.req("POST", `/api/trips/${tripId}/complete`, d);
    expect((await h.req("POST", `/api/trips/${tripId}/rating`, r, { stars: 5, comment: "great" })).statusCode).toBe(201);
    expect((await h.req("POST", `/api/trips/${tripId}/rating`, r, { stars: 1 })).statusCode).toBe(409);
    expect((await h.req("POST", `/api/trips/${tripId}/rating`, d, { stars: 4 })).statusCode).toBe(201);
    expect((await h.req("POST", `/api/trips/${tripId}/rating`, await h.rider(), { stars: 1 })).statusCode).toBe(404);
  });
});

describe("cancellations (workflow 07)", () => {
  const cancel = (tripId: string, who: { token: string }, reason = "CHANGED_PLANS") =>
    h.req("POST", `/api/trips/${tripId}/cancel`, who, { reason });

  it("rider: free within 2 min of matching, then the fee with 80% to the driver", async () => {
    const a = await h.matchedTrip();
    h.clock.now += 60_000;
    expect((await cancel(a.tripId, a.r)).json()).toMatchObject({ status: "cancelled", cancellation: { by: "RIDER", feeMinor: 0 } });

    const b = await h.matchedTrip();
    h.clock.now += 3 * 60_000;
    expect((await cancel(b.tripId, b.r)).json()).toMatchObject({ cancellation: { feeMinor: 3000, driverCompensationMinor: 2400 } });
    const [event] = await outbox(b.tripId, "trip.cancelled");
    expect(event).toMatchObject({ by: "RIDER", feeMinor: 3000, driverCompensationMinor: 2400, beneficiary: { type: "INDIVIDUAL", id: b.d.id } });
    expect(await h.c.db.driverActiveTrip.findUnique({ where: { driverUserId: b.d.id } })).toBeNull();
  });

  it("no-show: only after 5 min of waiting at the pickup", async () => {
    const { d, tripId } = await h.matchedTrip();
    await h.req("POST", `/api/trips/${tripId}/en-route`, d);
    await d.ping(near(BOLE, 30));
    await h.req("POST", `/api/trips/${tripId}/arrive`, d);
    expect((await cancel(tripId, d, "NO_SHOW")).json()).toMatchObject({ error: "too_early_for_no_show" });
    h.clock.now += 5 * 60_000;
    await d.ping(near(BOLE, 35));
    expect((await cancel(tripId, d, "NO_SHOW")).json()).toMatchObject({ cancellation: { by: "DRIVER", reason: "NO_SHOW", feeMinor: 3000 } });
  });

  it("drivers and staff cancel free; nobody cancels a started trip; strangers get 404", async () => {
    const a = await h.matchedTrip();
    h.clock.now += 10 * 60_000;
    expect((await cancel(a.tripId, a.d, "OTHER")).json()).toMatchObject({ cancellation: { by: "DRIVER", feeMinor: 0 } });

    const b = await h.matchedTrip();
    expect((await cancel(b.tripId, await h.rider())).statusCode).toBe(404);
    const support = await h.staff([{ r: "SUPPORT_AGENT", city: CITY }]);
    expect((await cancel(b.tripId, support, "STAFF_DECISION")).json()).toMatchObject({ cancellation: { by: "STAFF", feeMinor: 0 } });

    const c = await h.matchedTrip();
    await h.req("POST", `/api/trips/${c.tripId}/en-route`, c.d);
    await c.d.ping(near(BOLE, 10));
    await h.req("POST", `/api/trips/${c.tripId}/arrive`, c.d);
    await h.req("POST", `/api/trips/${c.tripId}/start`, c.d);
    expect((await cancel(c.tripId, c.r)).json()).toMatchObject({ error: "invalid_state" });
  });
});

describe("reading trips", () => {
  it("rider, driver and staff of the city can read; others get 404", async () => {
    const fleetOrgId = uuid();
    const { r, d, tripId } = await h.matchedTrip({ driverOpts: { fleetOrgId } });
    const get = (who: { token: string }) => h.req("GET", `/api/trips/${tripId}`, who).then((x) => x.statusCode);
    expect(await get(r)).toBe(200);
    expect(await get(d)).toBe(200);
    expect(await get(await h.rider())).toBe(404);
    expect(await get(await h.staff([{ r: "ANALYST", city: CITY }]))).toBe(200);
    expect(await get(await h.staff([{ r: "DISPATCHER", city: "hawassa" }]))).toBe(404);
    expect(await get(await h.rider(uuid(), [{ r: "FLEET_OWNER", org: fleetOrgId }]))).toBe(200);
    expect(await get(await h.rider(uuid(), [{ r: "FLEET_OWNER", org: uuid() }]))).toBe(404);
  });

  it("the dispatcher board lists active trips of the city", async () => {
    await h.requestTrip(await h.rider());
    const board = await h.req("GET", `/api/trips/board?cityId=${CITY}`, await h.staff([{ r: "DISPATCHER", city: CITY }]));
    expect(board.json<{ trips: unknown[] }>().trips.length).toBeGreaterThanOrEqual(1);
    expect((await h.req("GET", `/api/trips/board?cityId=${CITY}`, await h.rider())).statusCode).toBe(403);
  });

  it("my trips and my active trip", async () => {
    const { r, tripId } = await h.matchedTrip();
    expect((await h.req("GET", "/api/trips/active", r)).json()).toMatchObject({ trip: { id: tripId } });
    expect((await h.req("GET", "/api/trips?as=rider", r)).json<{ trips: { id: string }[] }>().trips[0]?.id).toBe(tripId);
  });
});

describe("admin settings (platform-service), live", () => {
  it("maintenance pauses new trips with the configured message; flags turn booking channels off", async () => {
    const r = await h.rider();
    h.settings.set("maintenance.newTrips", true);
    h.settings.set("maintenance.message", "Back at 10:00");
    try {
      const res = await h.requestTrip(r);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "maintenance", message: "Back at 10:00" });
    } finally {
      h.settings.set("maintenance.newTrips", false);
    }

    const agent = await h.staff([{ r: "CALL_CENTER_AGENT", city: CITY }]);
    const guest = uuid();
    h.settings.set("features.phoneBooking", false);
    try {
      const q = await h.quote(agent);
      const res = await h.req("POST", "/api/trips", agent, { quoteId: q.id, paymentMethod: "CASH", riderUserId: guest });
      expect(res.json()).toMatchObject({ error: "feature_disabled" });
    } finally {
      h.settings.set("features.phoneBooking", true);
    }
  });

  it("fares and cancellation fees follow the city's settings", async () => {
    const r = await h.rider();
    const before = (await h.quote(r)).fareMinor;
    h.settings.set("fares.economy.baseMinor", 50_000, CITY);
    try {
      expect((await h.quote(r)).fareMinor).toBe(before + 45_000);
    } finally {
      h.settings.set("fares.economy.baseMinor", 5000, CITY);
    }

    h.settings.set("cancel.feeMinor", 7000, CITY);
    h.settings.set("cancel.freeSeconds", 0, CITY);
    try {
      const { r: rider, tripId } = await h.matchedTrip();
      h.clock.now += 5000;
      const res = await h.req("POST", `/api/trips/${tripId}/cancel`, rider, { reason: "CHANGED_PLANS" });
      expect(res.json<{ cancellation: { feeMinor: number } }>().cancellation.feeMinor).toBe(7000);
    } finally {
      h.settings.set("cancel.feeMinor", 3000, CITY);
      h.settings.set("cancel.freeSeconds", 120, CITY);
    }
  });
});
