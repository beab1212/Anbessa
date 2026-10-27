// Scheduled rides (workflow 12), dispatcher reassignment, company ride policies (workflow 11),
// the GPS trace and the regulatory report.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getDriverState } from "@ride-app/shared-location";
import { createHandlers } from "../../src/events/consumer.js";
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
  // Wednesday 4 Nov 2026, 10:00 in Addis Ababa
  h.clock.now = Date.parse("2026-11-04T07:00:00Z");
  h.settings.set("features.scheduledRides", true);
});

const MIN = 60_000;
const outbox = (key: string, topic: string) =>
  h.c.db.outbox.findMany({ where: { key, topic } }).then((rows) => rows.map((r) => r.payload as Record<string, unknown>));
const patch = (url: string, who: { token: string }, payload: object) =>
  h.app.inject({ method: "PATCH", url, payload, headers: { authorization: `Bearer ${who.token}` } });

interface Scheduled { id: string; status: string; tripId: string | null; scheduledFor: string; matchAt: string; editable: boolean; fare: { estimateMinor: number }; failReason: string | null }

async function book(who: { token: string; id: string }, aheadMinutes = 120, body: Record<string, unknown> = {}) {
  const q = await h.quote(who);
  const res = await h.req("POST", "/api/trips/scheduled", who, {
    quoteId: q.id, paymentMethod: "MOBILE_MONEY", scheduledFor: new Date(h.clock.now + aheadMinutes * MIN).toISOString(), ...body,
  });
  return { res, quote: q };
}

describe("scheduled rides (workflow 12)", () => {
  it("books ahead, lists it, and turns it into a requested trip at the lead time", async () => {
    const r = await h.rider();
    const { res, quote } = await book(r, 120);
    expect(res.statusCode).toBe(201);
    const s = res.json<Scheduled>();
    expect(s).toMatchObject({ status: "SCHEDULED", tripId: null, editable: true, fare: { estimateMinor: quote.fareMinor } });
    // 12:00 Addis: day lead time, 15 min
    expect(Date.parse(s.matchAt)).toBe(Date.parse(s.scheduledFor) - 15 * MIN);
    expect(await outbox(s.id, "trip.scheduled")).toEqual([expect.objectContaining({ scheduledTripId: s.id, riderId: r.id, channel: "APP" })]);

    const mine = (await h.req("GET", "/api/trips/scheduled", r)).json<{ scheduled: Scheduled[] }>().scheduled;
    expect(mine.map((x) => x.id)).toEqual([s.id]);
    // somebody else can't see it
    expect((await h.req("GET", `/api/trips/scheduled/${s.id}`, await h.rider())).statusCode).toBe(404);

    // not due yet
    expect(await h.c.scheduler.tick()).toBe(0);
    h.clock.now = Date.parse(s.matchAt) + 1000;
    expect(await h.c.scheduler.tick()).toBe(1);
    const after = (await h.req("GET", `/api/trips/scheduled/${s.id}`, r)).json<Scheduled>();
    expect(after).toMatchObject({ status: "DISPATCHED", editable: false });
    const trip = await h.c.db.trip.findUniqueOrThrow({ where: { id: after.tripId! } });
    expect(trip).toMatchObject({ status: "requested", riderUserId: r.id, channel: "APP", paymentMethod: "MOBILE_MONEY" });
    // re-priced near dispatch, never above the booked fare
    expect(Number(trip.fareEstimateMinor)).toBeLessThanOrEqual(quote.fareMinor);
    expect(await outbox(trip.id, "trip.requested")).toHaveLength(1);
    expect(h.pushes.some((p) => p.userId === r.id && p.event === "scheduled:status" && p.payload.status === "DISPATCHED")).toBe(true);
    // the matcher picked it up
    expect(await h.redis.zscore("match:due", trip.id)).not.toBeNull();
    // ticking again does nothing
    expect(await h.c.scheduler.tick()).toBe(0);
  });

  it("uses the longer lead time at night, and checks the booking window", async () => {
    const r = await h.rider();
    // 10:00 + 14 h = 00:00 Addis
    const night = (await book(r, 14 * 60)).res.json<Scheduled>();
    expect(Date.parse(night.matchAt)).toBe(Date.parse(night.scheduledFor) - 30 * MIN);
    expect((await book(r, 20)).res.json()).toMatchObject({ error: "too_soon" });
    expect((await book(r, 8 * 24 * 60)).res.json()).toMatchObject({ error: "too_far_ahead" });
    // two rides of one rider within an hour
    expect((await book(r, 14 * 60 + 30)).res.json()).toMatchObject({ error: "schedule_conflict" });
  });

  it("is refused while the feature flag is off", async () => {
    h.settings.set("features.scheduledRides", false);
    const { res } = await book(await h.rider());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "feature_disabled" });
  });

  it("can be moved and cancelled (free) before dispatch, not after", async () => {
    const r = await h.rider();
    const s = (await book(r, 180)).res.json<Scheduled>();
    const later = new Date(h.clock.now + 240 * MIN).toISOString();
    const moved = await patch(`/api/trips/scheduled/${s.id}`, r, { scheduledFor: later, purpose: "airport" });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ scheduledFor: later, purpose: "airport" });
    expect((await outbox(s.id, "trip.scheduled")).at(-1)).toMatchObject({ updated: true, scheduledFor: later });
    // someone else can't touch it
    expect((await h.req("POST", `/api/trips/scheduled/${s.id}/cancel`, await h.rider())).statusCode).toBe(404);

    const cancelled = await h.req("POST", `/api/trips/scheduled/${s.id}/cancel`, r);
    expect(cancelled.json()).toMatchObject({ status: "CANCELLED" });
    expect(await outbox(s.id, "trip.schedule_cancelled")).toEqual([expect.objectContaining({ by: "RIDER", byUserId: r.id })]);
    h.clock.now += 240 * MIN;
    expect(await h.c.scheduler.tick()).toBe(0);

    const s2 = (await book(r, 120)).res.json<Scheduled>();
    h.clock.now = Date.parse(s2.matchAt);
    await h.c.scheduler.tick();
    expect((await h.req("POST", `/api/trips/scheduled/${s2.id}/cancel`, r)).statusCode).toBe(409);
    expect((await patch(`/api/trips/scheduled/${s2.id}`, r, { purpose: "x" })).statusCode).toBe(409);
  });

  it("waits while the rider is still on another trip, and fails once the pickup time has passed", async () => {
    const r = await h.rider();
    const s = (await book(r, 60)).res.json<Scheduled>();
    // the rider is on a ride when the booking comes due
    expect((await h.requestTrip(r)).statusCode).toBe(201);
    h.clock.now = Date.parse(s.matchAt);
    await h.c.scheduler.tick();
    expect((await h.c.db.scheduledTrip.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("SCHEDULED");
    h.clock.now = Date.parse(s.scheduledFor) + 1000;
    await h.c.scheduler.tick();
    expect(await h.c.db.scheduledTrip.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "FAILED", failReason: "RIDER_HAS_ACTIVE_TRIP" });
    expect(await outbox(s.id, "trip.schedule_failed")).toHaveLength(1);
  });

  it("a scheduled trip nobody accepts is escalated to dispatch and keeps searching until after the pickup time", async () => {
    const r = await h.rider();
    const s = (await book(r, 60)).res.json<Scheduled>();
    h.clock.now = Date.parse(s.matchAt);
    await h.c.scheduler.tick();
    const tripId = (await h.c.db.scheduledTrip.findUniqueOrThrow({ where: { id: s.id } })).tripId!;

    h.clock.now += 121_000;
    expect(await h.c.matcher.step(tripId)).not.toBeNull();
    const t = await h.c.db.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(t.status).toBe("requested");
    expect(t.flags).toContain("DISPATCH_ESCALATED");
    expect(await outbox(tripId, "trip.dispatch_escalated")).toEqual([expect.objectContaining({ scheduledTripId: s.id })]);
    // escalated once only
    h.clock.now += 121_000;
    await h.c.matcher.step(tripId);
    expect(await outbox(tripId, "trip.dispatch_escalated")).toHaveLength(1);
    // the dispatcher board shows the flag
    const dispatcher = await h.staff([{ r: "DISPATCHER", city: CITY }]);
    const board = (await h.req("GET", `/api/trips/board?cityId=${CITY}`, dispatcher)).json<{ trips: { id: string; flags: string[] }[] }>().trips;
    expect(board.find((x) => x.id === tripId)?.flags).toContain("DISPATCH_ESCALATED");

    // 10 min after the pickup time: cancelled like any trip without a driver
    h.clock.now = Date.parse(s.scheduledFor) + 11 * MIN;
    expect(await h.c.matcher.step(tripId)).toBeNull();
    expect(await h.c.db.trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({ status: "cancelled", cancelReason: "NO_DRIVER_FOUND" });
  });

  it("a coordinator books for a guest on the company account; the company and staff list it", async () => {
    const org = uuid();
    const coordinator = await h.rider(uuid(), [{ r: "CORPORATE_COORDINATOR", org }]);
    const guest = uuid();
    const { res } = await book(coordinator, 120, { paymentMethod: "CORPORATE", billingOrgId: org, riderUserId: guest });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ channel: "CORPORATE_PORTAL", riderUserId: guest, billing: { type: "CORPORATE", orgId: org } });
    const admin = await h.rider(uuid(), [{ r: "CORPORATE_ADMIN", org }]);
    expect((await h.req("GET", `/api/trips/scheduled?orgId=${org}`, admin)).json<{ scheduled: unknown[] }>().scheduled).toHaveLength(1);
    expect((await h.req("GET", `/api/trips/scheduled?orgId=${uuid()}`, admin)).statusCode).toBe(403);
    const agent = await h.staff([{ r: "CALL_CENTER_AGENT", city: CITY }]);
    const cityList = (await h.req("GET", `/api/trips/scheduled?cityId=${CITY}`, agent)).json<{ scheduled: { id: string }[] }>().scheduled;
    expect(cityList.map((x) => x.id)).toContain(res.json<Scheduled>().id);
    expect((await h.req("GET", `/api/trips/scheduled?cityId=hawassa`, agent)).statusCode).toBe(403);
  });
});

describe("company ride policies (workflow 11)", () => {
  async function company(policy: Record<string, unknown>) {
    const org = uuid();
    const admin = await h.rider(uuid(), [{ r: "CORPORATE_ADMIN", org }]);
    const put = await h.req("PUT", `/api/trips/corporate/${org}/policy`, admin, policy);
    expect(put.statusCode).toBe(200);
    const employee = await h.rider(uuid(), [{ r: "RIDER" }, { r: "CORPORATE_EMPLOYEE", org }]);
    return { org, admin, employee };
  }
  const corporateTrip = (who: { token: string }, org: string, extra: Record<string, unknown> = {}) =>
    h.requestTrip(who, { paymentMethod: "CORPORATE", billingOrgId: org, ...extra });

  it("only the company's admin sets it; employees read it; it is published and audited", async () => {
    const { org, admin, employee } = await company({ allowedVehicleTypes: ["economy"], startMinute: 360, endMinute: 1320, requirePurpose: true });
    const read = (await h.req("GET", `/api/trips/corporate/${org}/policy`, employee)).json();
    expect(read).toMatchObject({ configured: true, allowedVehicleTypes: ["economy"], startMinute: 360, endMinute: 1320, requirePurpose: true, spentThisMonthMinor: 0 });
    expect((await h.req("PUT", `/api/trips/corporate/${org}/policy`, employee, {})).statusCode).toBe(403);
    const coordinator = await h.rider(uuid(), [{ r: "CORPORATE_COORDINATOR", org }]);
    expect((await h.req("PUT", `/api/trips/corporate/${org}/policy`, coordinator, {})).statusCode).toBe(403);
    expect((await h.req("PUT", `/api/trips/corporate/${uuid()}/policy`, admin, {})).statusCode).toBe(403);
    expect((await h.req("PUT", `/api/trips/corporate/${org}/policy`, admin, { startMinute: 360 })).statusCode).toBe(400);
    expect(await outbox(org, "corporate.policy_updated")).toEqual([expect.objectContaining({ orgId: org, byUserId: admin.id, requirePurpose: true })]);
    expect(await outbox(admin.id, "audit.recorded")).toEqual([expect.objectContaining({ action: "corporate:manage_policies", outcome: "EXECUTED", service: "trip-service" })]);
  });

  it("refuses rides outside the allowed hours and days, with the rule", async () => {
    const { org, employee } = await company({ startMinute: 6 * 60, endMinute: 9 * 60 });
    const res = await corporateTrip(employee, org); // 10:00 Addis
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "policy_violation", rule: "hours", message: "Your company allows rides 06:00–09:00 only" });
    // personal payment is still fine
    expect((await h.requestTrip(employee)).statusCode).toBe(201);

    const weekend = await company({ allowedDays: [0, 6] });
    expect((await corporateTrip(weekend.employee, weekend.org)).json()).toMatchObject({ rule: "day" });
    const overnight = await company({ startMinute: 22 * 60, endMinute: 11 * 60 });
    expect((await corporateTrip(overnight.employee, overnight.org)).statusCode).toBe(201);
  });

  it("checks vehicle type, fare, purpose and the monthly budget", async () => {
    const q = await h.quote(await h.rider());
    const types = await company({ allowedVehicleTypes: ["comfort"] });
    expect((await corporateTrip(types.employee, types.org)).json()).toMatchObject({ rule: "vehicle_type" });
    const cheap = await company({ maxFareMinor: q.fareMinor - 100 });
    expect((await corporateTrip(cheap.employee, cheap.org)).json()).toMatchObject({ rule: "max_fare" });
    const purpose = await company({ requirePurpose: true });
    expect((await corporateTrip(purpose.employee, purpose.org)).json()).toMatchObject({ rule: "purpose" });
    const ok = await corporateTrip(purpose.employee, purpose.org, { purpose: "client visit" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ purpose: "client visit" });

    // budget for one ride: the second (and a scheduled one in the same month) goes over
    const budget = await company({ monthlyBudgetMinor: Math.round(q.fareMinor * 1.5) });
    expect((await corporateTrip(budget.employee, budget.org)).statusCode).toBe(201);
    const other = await h.rider(uuid(), [{ r: "RIDER" }, { r: "CORPORATE_EMPLOYEE", org: budget.org }]);
    expect((await corporateTrip(other, budget.org)).json()).toMatchObject({ rule: "monthly_budget" });
    expect((await book(other, 120, { paymentMethod: "CORPORATE", billingOrgId: budget.org })).res.json()).toMatchObject({ rule: "monthly_budget" });
  });

  it("applies to scheduled rides at their pickup time", async () => {
    const { org, employee } = await company({ startMinute: 6 * 60, endMinute: 22 * 60 });
    // 10:00 + 13 h = 23:00 Addis
    expect((await book(employee, 13 * 60, { paymentMethod: "CORPORATE", billingOrgId: org })).res.json()).toMatchObject({ rule: "hours" });
    expect((await book(employee, 3 * 60, { paymentMethod: "CORPORATE", billingOrgId: org })).res.statusCode).toBe(201);
  });
});

describe("reassignment (trip:reassign)", () => {
  it("moves a matched trip to another driver: the old driver is freed and told, the rider sees the new one", async () => {
    const { r, d, tripId } = await h.matchedTrip();
    const d2 = await h.driver(near(BOLE, 100));
    const dispatcher = await h.staff([{ r: "DISPATCHER", city: CITY }]);
    const res = await h.req("POST", `/api/trips/${tripId}/reassign`, dispatcher, { driverId: d2.id, reason: "driver not moving" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "matched", driver: { userId: d2.id }, flags: expect.arrayContaining(["REASSIGNED"]) });
    expect(await h.c.db.driverActiveTrip.findUnique({ where: { driverUserId: d.id } })).toBeNull();
    expect(await h.c.db.driverActiveTrip.findUnique({ where: { driverUserId: d2.id } })).toMatchObject({ tripId });
    expect(await getDriverState(h.redis, d.id)).toMatchObject({ status: "available", tripId: undefined });
    expect(h.pushes.some((p) => p.userId === d.id && p.event === "trip:reassigned")).toBe(true);
    expect(h.pushes.some((p) => p.userId === r.id && p.event === "trip:status" && (p.payload.trip as { driver: { userId: string } | null }).driver?.userId === d2.id)).toBe(true);
    expect(await outbox(tripId, "trip.reassigned")).toEqual([expect.objectContaining({ fromDriverId: d.id, toDriverId: d2.id, byUserId: dispatcher.id, reason: "driver not moving" })]);
    expect((await outbox(tripId, "trip.matched")).at(-1)).toMatchObject({ driverId: d2.id });
    expect(await outbox(dispatcher.id, "audit.recorded")).toEqual([expect.objectContaining({ action: "trip:reassign", resource: { type: "trip", id: tripId } })]);
    // the old driver can no longer drive it
    expect((await h.req("POST", `/api/trips/${tripId}/en-route`, d)).statusCode).toBe(404);
    expect((await h.req("POST", `/api/trips/${tripId}/en-route`, d2)).json()).toMatchObject({ status: "en_route" });
  });

  it("puts a trip back to matching without the old driver", async () => {
    const { d, tripId } = await h.matchedTrip();
    await h.req("POST", `/api/trips/${tripId}/en-route`, d);
    const d2 = await h.driver(near(BOLE, 200));
    const dispatcher = await h.staff([{ r: "DISPATCHER", city: CITY }]);
    const res = await h.req("POST", `/api/trips/${tripId}/reassign`, dispatcher, {});
    expect(res.json()).toMatchObject({ status: "requested", driver: null });
    const offer = await h.offerFor(tripId);
    expect(offer?.driverUserId).toBe(d2.id);
  });

  it("only dispatchers of the city, and only before pickup", async () => {
    const { d, tripId } = await h.matchedTrip();
    const d2 = await h.driver(near(BOLE, 100));
    expect((await h.req("POST", `/api/trips/${tripId}/reassign`, await h.staff([{ r: "SUPPORT_AGENT", city: CITY }]), { driverId: d2.id })).statusCode).toBe(403);
    expect((await h.req("POST", `/api/trips/${tripId}/reassign`, await h.staff([{ r: "DISPATCHER", city: "hawassa" }]), { driverId: d2.id })).statusCode).toBe(403);
    const dispatcher = await h.staff([{ r: "DISPATCHER", city: CITY }]);
    expect((await h.req("POST", `/api/trips/${tripId}/reassign`, dispatcher, { driverId: d.id })).json()).toMatchObject({ error: "same_driver" });
    await h.req("POST", `/api/trips/${tripId}/en-route`, d);
    await h.req("POST", `/api/trips/${tripId}/arrive`, d);
    await h.req("POST", `/api/trips/${tripId}/start`, d, {});
    expect((await h.req("POST", `/api/trips/${tripId}/reassign`, dispatcher, { driverId: d2.id })).statusCode).toBe(409);
  });
});

describe("GPS trace (trip:read_gps_trace)", () => {
  it("keeps a thinned trace of the trip's driver, and the ride's driven distance becomes the trip's", async () => {
    const { d, tripId } = await h.matchedTrip();
    const rec = (p: { lat: number; lng: number }, at: number, driverId = d.id) =>
      h.c.traceRecorder.record({ driverId, tripId, cityId: CITY, lat: p.lat, lng: p.lng, at, accuracy: 5 });
    const t0 = h.clock.now;
    expect(await rec(near(BOLE, 20), t0)).toBe(true);
    // 2 s later and 5 m away: thinned out
    expect(await rec(near(BOLE, 25), t0 + 2000)).toBe(false);
    // somebody else's ping with this trip id: ignored
    expect(await rec(near(BOLE, 500), t0 + 10_000, uuid())).toBe(false);
    // standing still a minute: one heartbeat point
    expect(await rec(near(BOLE, 21), t0 + 61_000)).toBe(true);

    h.clock.now = t0 + 62_000;
    await d.ping(near(BOLE, 20));
    await h.req("POST", `/api/trips/${tripId}/en-route`, d);
    await h.req("POST", `/api/trips/${tripId}/arrive`, d);
    expect((await h.req("POST", `/api/trips/${tripId}/start`, d, {})).json()).toMatchObject({ status: "in_progress" });
    h.c.traceRecorder.forget(tripId);
    // the ride: 3 points, 1 km apart, 100 s each
    const start = h.clock.now + 10_000;
    for (let i = 0; i < 3; i++) expect(await rec(near(BOLE, 100 + i * 1000), start + i * 100_000)).toBe(true);
    h.clock.now = start + 200_000 + 1000;
    await d.ping(near(PIASSA, 10));
    const done = (await h.req("POST", `/api/trips/${tripId}/complete`, d)).json<{ route: { distanceMeters: number } }>();
    expect(done.route.distanceMeters).toBeGreaterThan(1990);
    expect(done.route.distanceMeters).toBeLessThan(2010);
    // after completion: no more points
    h.c.traceRecorder.forget(tripId);
    expect(await rec(near(BOLE, 5000), h.clock.now + 10_000)).toBe(false);

    const safety = await h.staff([{ r: "SAFETY_OFFICER", city: CITY }]);
    const res = await h.req("GET", `/api/trips/${tripId}/trace?reason=${encodeURIComponent("ticket 42")}`, safety);
    expect(res.statusCode).toBe(200);
    const trace = res.json<{ count: number; polyline6: string; points: { phase: string }[]; rideDistanceMeters: number }>();
    expect(trace.count).toBe(5);
    expect(trace.points.map((x) => x.phase)).toEqual(["to_pickup", "to_pickup", "ride", "ride", "ride"]);
    expect(trace.rideDistanceMeters).toBe(done.route.distanceMeters);
    expect(trace.polyline6.length).toBeGreaterThan(10);
    expect(await outbox(safety.id, "audit.recorded")).toEqual([expect.objectContaining({ action: "trip:read_gps_trace", outcome: "ALLOWED", reason: "ticket 42" })]);
    const csv = await h.req("GET", `/api/trips/${tripId}/trace.csv`, safety);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.trim().split("\n")).toHaveLength(6);

    // dispatchers may; support, other cities and riders may not
    expect((await h.req("GET", `/api/trips/${tripId}/trace`, await h.staff([{ r: "DISPATCHER", city: CITY }]))).statusCode).toBe(200);
    expect((await h.req("GET", `/api/trips/${tripId}/trace`, await h.staff([{ r: "SUPPORT_AGENT", city: CITY }]))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/trips/${tripId}/trace`, await h.staff([{ r: "SAFETY_OFFICER", city: "hawassa" }]))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/trips/${tripId}/trace`, d)).statusCode).toBe(403);
  });
});

describe("regulatory report (report:read_regulatory)", () => {
  it("counts trips, drivers, vehicles and incidents per month and city, as JSON and CSV", async () => {
    const city = `reg-${Math.random().toString(36).slice(2, 8)}`;
    const seed = (data: Record<string, unknown>) => h.c.db.trip.create({
      data: {
        cityId: city, riderUserId: uuid(), bookedByUserId: uuid(), channel: "APP", billingType: "PERSONAL", paymentMethod: "CASH",
        vehicleType: "economy", pickupLat: 9, pickupLng: 38.7, dropoffLat: 9.01, dropoffLng: 38.71, fareEstimateMinor: 10000n,
        estDistanceM: 5000, estDurationS: 600, pin: "1234", ...data,
      },
    });
    const driver = uuid();
    const sep = new Date("2026-09-10T10:00:00Z");
    await seed({ status: "completed", createdAt: sep, completedAt: sep, driverUserId: driver, vehicleId: "v1", distanceM: 7000 });
    await seed({ status: "completed", createdAt: sep, completedAt: sep, driverUserId: driver, vehicleId: "v1" });
    await seed({ status: "completed", createdAt: sep, completedAt: sep, driverUserId: uuid(), vehicleId: "v2", distanceM: 3000 });
    await seed({ status: "cancelled", createdAt: sep, cancelledAt: sep, cancelledBy: "SYSTEM", cancelReason: "NO_DRIVER_FOUND" });
    // 30 Sep 22:00 UTC is 1 Oct in Addis
    await seed({ status: "cancelled", createdAt: new Date("2026-09-30T22:00:00Z"), cancelledAt: new Date("2026-09-30T22:05:00Z"), cancelledBy: "RIDER", cancelReason: "CHANGED_PLANS" });
    // through the Kafka handler, like support-service's incident.opened
    const handlers = createHandlers({ trace: h.c.traceRecorder, regulatory: h.c.regulatory });
    await handlers["incident.opened"]({ eventId: uuid(), version: 1, incidentId: uuid(), ref: 7, cityId: city, category: "ACCIDENT", severity: "HIGH", source: "SOS", subjectUserIds: [], byUserId: null, at: "2026-09-12T08:00:00Z" });
    await expect(handlers["incident.opened"]({ incidentId: "nope" })).rejects.toBeInstanceOf(ZodError);
    // a ping without a trip is ignored
    await handlers["driver.location"]({ driverId: uuid(), cityId: city, lat: 9, lng: 38.7, at: Date.now() });
    const incident = { incidentId: uuid(), cityId: city, category: "OTHER", severity: "LOW", at: "2026-09-13T08:00:00Z" };
    await h.c.regulatory.recordIncident(incident);
    await h.c.regulatory.recordIncident(incident); // replayed event

    const regulator = await h.staff([{ r: "REGULATOR" }]);
    const res = await h.req("GET", `/api/trips/reports/regulatory?cityId=${city}&from=2026-09&to=2026-10`, regulator);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      from: "2026-09", to: "2026-10",
      rows: [
        { month: "2026-09", cityId: city, tripsRequested: 4, tripsCompleted: 3, tripsCancelled: 1, tripsNoDriver: 1, activeDrivers: 2, activeVehicles: 2, distanceKm: 15, safetyIncidents: 2, seriousIncidents: 1 },
        { month: "2026-10", cityId: city, tripsRequested: 1, tripsCompleted: 0, tripsCancelled: 1, safetyIncidents: 0 },
      ],
    });
    const csv = await h.req("GET", `/api/trips/reports/regulatory.csv?cityId=${city}&from=2026-09&to=2026-09`, regulator);
    expect(csv.headers["content-disposition"]).toContain(`regulatory-${city}-2026-09-2026-09.csv`);
    expect(csv.body.split("\r\n")[0]).toBe("month,city,trips_requested,trips_completed,trips_cancelled,trips_no_driver_found,active_drivers,active_vehicles,distance_km,safety_incidents,serious_safety_incidents");
    expect(csv.body.split("\r\n")[1]).toBe(`2026-09,${city},4,3,1,1,2,2,15,2,1`);

    // the internal auditor too; nobody else
    expect((await h.req("GET", `/api/trips/reports/regulatory?cityId=${city}&from=2026-09`, await h.staff([{ r: "AUDITOR" }]))).statusCode).toBe(200);
    expect((await h.req("GET", `/api/trips/reports/regulatory?cityId=${city}`, await h.staff([{ r: "ANALYST", g: true }]))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/trips/reports/regulatory?from=2025-01&to=2026-09`, regulator)).json()).toMatchObject({ error: "invalid_range" });
  });
});
