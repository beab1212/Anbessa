import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOLE, createHarness, PIASSA, uuid, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

type TripRow = { id: string; status: string; cityId: string; pin?: string; flags?: string[]; billing: { orgId: string | null } };
type Page = { trips: TripRow[]; next: string | null };

/** A city of its own per test, so rows from other tests never count. */
const freshCity = () => `t-${uuid().slice(0, 8)}`;

/** Insert a trip as it would look after the lifecycle (no matching needed for lists and reports). */
async function seed(cityId: string, o: {
  status?: "requested" | "matched" | "completed" | "cancelled"; createdAt?: Date; channel?: string; paymentMethod?: string; vehicleType?: string;
  riderUserId?: string; driverUserId?: string; vehicleId?: string; billingOrgId?: string; fleetOrgId?: string;
  fareFinalMinor?: number; cancelledBy?: string; cancelReason?: string; cancelFeeMinor?: number; matchedAfterSeconds?: number;
} = {}) {
  const status = o.status ?? "completed";
  const createdAt = o.createdAt ?? new Date();
  const hasDriver = status !== "requested" && !(status === "cancelled" && !o.driverUserId);
  const driverUserId = hasDriver ? (o.driverUserId ?? uuid()) : null;
  const riderUserId = o.riderUserId ?? uuid();
  return h.c.db.trip.create({
    data: {
      cityId, riderUserId, bookedByUserId: riderUserId, channel: o.channel ?? "APP",
      billingType: o.billingOrgId ? "CORPORATE" : "PERSONAL", billingOrgId: o.billingOrgId ?? null,
      paymentMethod: o.billingOrgId ? "CORPORATE" : (o.paymentMethod ?? "CASH"), status, vehicleType: o.vehicleType ?? "economy",
      pickupLat: BOLE.lat, pickupLng: BOLE.lng, dropoffLat: PIASSA.lat, dropoffLng: PIASSA.lng,
      fareEstimateMinor: 20_000n, estDistanceM: 7400, estDurationS: 900, pin: "1234", createdAt,
      ...(driverUserId ? {
        driverUserId, vehicleId: o.vehicleId ?? `veh-${driverUserId.slice(0, 6)}`,
        vehicleOwnerType: o.fleetOrgId ? "ORGANIZATION" : "INDIVIDUAL", beneficiaryId: o.fleetOrgId ?? driverUserId,
        matchedAt: new Date(createdAt.getTime() + (o.matchedAfterSeconds ?? 30) * 1000),
      } : {}),
      ...(status === "completed" ? { fareFinalMinor: BigInt(o.fareFinalMinor ?? 20_000), completedAt: new Date(createdAt.getTime() + 1_200_000) } : {}),
      ...(status === "cancelled" ? {
        cancelledAt: new Date(createdAt.getTime() + 60_000), cancelledBy: o.cancelledBy ?? "RIDER", cancelReason: o.cancelReason ?? "CHANGED_PLANS",
        cancelFeeMinor: BigInt(o.cancelFeeMinor ?? 0), driverCompensationMinor: 0n,
      } : {}),
    },
  });
}

/** Every page of a list, following `next`. */
async function all(url: string, who: { token: string }) {
  const out: TripRow[] = [];
  let next: string | null = null;
  for (let i = 0; i < 20; i++) {
    const r = await h.req("GET", `${url}${next ? `&before=${encodeURIComponent(next)}` : ""}`, who);
    expect(r.statusCode, r.body).toBe(200);
    const page = r.json<Page>();
    out.push(...page.trips);
    next = page.next;
    if (!next) break;
  }
  return out;
}

describe("staff trip search", () => {
  it("filters a city's trips and pages through ties in created_at without skipping or repeating", async () => {
    const city = freshCity();
    const at = new Date("2026-10-20T09:00:00.000Z");
    const rider = uuid();
    const driver = uuid();
    const org = uuid();
    // five trips created in the same instant (the cursor must break ties by id)
    const same = await Promise.all([1, 2, 3, 4, 5].map(() => seed(city, { createdAt: at })));
    const a = await seed(city, { createdAt: new Date("2026-10-21T08:00:00Z"), riderUserId: rider, channel: "PHONE", paymentMethod: "MOBILE_MONEY" });
    const b = await seed(city, { createdAt: new Date("2026-10-22T08:00:00Z"), driverUserId: driver, vehicleId: "veh-search-1", status: "cancelled" });
    const c = await seed(city, { createdAt: new Date("2026-10-23T08:00:00Z"), billingOrgId: org, channel: "CORPORATE_PORTAL" });
    await seed(freshCity(), { createdAt: at }); // another city

    const dispatcher = await h.staff([{ r: "DISPATCHER", city }]);
    const everything = await all(`/api/trips/search?cityId=${city}&limit=2`, dispatcher);
    expect(everything.map((t) => t.id).sort()).toEqual([...same, a, b, c].map((t) => t.id).sort());
    expect(new Set(everything.map((t) => t.id)).size).toBe(8);
    // newest first
    expect(everything[0]!.id).toBe(c.id);
    // staff view: review flags, no PIN
    expect(everything[0]).toHaveProperty("flags");
    expect(everything[0]).not.toHaveProperty("pin");

    const one = async (q: string) => (await all(`/api/trips/search?cityId=${city}&${q}`, dispatcher)).map((t) => t.id);
    expect(await one("status=cancelled")).toEqual([b.id]);
    expect(await one("channel=PHONE")).toEqual([a.id]);
    expect(await one("paymentMethod=MOBILE_MONEY")).toEqual([a.id]);
    expect(await one(`riderUserId=${rider}`)).toEqual([a.id]);
    expect(await one(`driverUserId=${driver}`)).toEqual([b.id]);
    expect(await one("vehicleId=veh-search-1")).toEqual([b.id]);
    expect(await one(`billingOrgId=${org}`)).toEqual([c.id]);
    expect(await one(`q=${c.id.slice(0, 13)}`)).toContain(c.id);
    expect(await one(`q=${c.id}`)).toEqual([c.id]);
    // Addis days, inclusive: 21st and 22nd
    expect((await one("from=2026-10-21&to=2026-10-22")).sort()).toEqual([a.id, b.id].sort());
    expect((await h.req("GET", `/api/trips/search?cityId=${city}&from=2026-01-01&to=2026-12-31`, dispatcher)).json()).toMatchObject({ error: "invalid_range" });
    expect((await h.req("GET", `/api/trips/search?cityId=${city}&q=xyz`, dispatcher)).statusCode).toBe(400);
  });

  it("city staff search their own city only; global holders may leave the city out", async () => {
    const city = freshCity();
    const t = await seed(city);
    const dispatcher = await h.staff([{ r: "DISPATCHER", city }]);
    expect((await h.req("GET", `/api/trips/search?cityId=${freshCity()}`, dispatcher)).statusCode).toBe(403);
    expect((await h.req("GET", "/api/trips/search", dispatcher)).json()).toMatchObject({ error: "city_required" });
    // riders and partners hold no city scope
    expect((await h.req("GET", `/api/trips/search?cityId=${city}`, await h.rider())).statusCode).toBe(403);
    expect((await h.req("GET", "/api/trips/search", await h.rider())).statusCode).toBe(403);
    // a role without trip:read
    expect((await h.req("GET", `/api/trips/search?cityId=${city}`, await h.staff([{ r: "MARKETING", city }]))).statusCode).toBe(403);

    const finance = await h.staff([{ r: "FINANCE_OFFICER" }]);
    const r = await h.req("GET", `/api/trips/search?q=${t.id}`, finance);
    expect(r.statusCode).toBe(200);
    expect(r.json<Page>().trips.map((x) => x.id)).toEqual([t.id]);
    // a city role held globally covers every city
    const analyst = await h.staff([{ r: "ANALYST", g: true }]);
    expect((await h.req("GET", `/api/trips/search?cityId=${city}`, analyst)).json<Page>().trips).toHaveLength(1);
  });
});

describe("company and fleet trip lists", () => {
  it("a company sees the trips billed to it, without the PIN; another company's list is refused", async () => {
    const city = freshCity();
    const org = uuid();
    const other = uuid();
    const admin = await h.rider(uuid(), [{ r: "CORPORATE_ADMIN", org }]);
    const coordinator = await h.rider(uuid(), [{ r: "CORPORATE_COORDINATOR", org }]);
    // booked by the coordinator: still no PIN in the company list
    const booked = await seed(city, { billingOrgId: org, riderUserId: uuid(), createdAt: new Date("2026-10-20T10:00:00Z") });
    await h.c.db.trip.update({ where: { id: booked.id }, data: { bookedByUserId: coordinator.id } });
    const second = await seed(city, { billingOrgId: org, status: "cancelled", createdAt: new Date("2026-10-21T10:00:00Z") });
    await seed(city, { billingOrgId: other });

    const list = await all(`/api/trips/org/${org}?role=billing&limit=1`, admin);
    expect(list.map((t) => t.id)).toEqual([second.id, booked.id]);
    const mine = await all(`/api/trips/org/${org}?role=billing`, coordinator);
    expect(mine).toHaveLength(2);
    for (const t of mine) {
      expect(t).not.toHaveProperty("pin");
      expect(t).not.toHaveProperty("flags");
      expect(t.billing.orgId).toBe(org);
    }
    expect((await all(`/api/trips/org/${org}?role=billing&status=cancelled`, admin)).map((t) => t.id)).toEqual([second.id]);
    expect((await all(`/api/trips/org/${org}?role=billing&from=2026-10-20&to=2026-10-20`, admin)).map((t) => t.id)).toEqual([booked.id]);

    expect((await h.req("GET", `/api/trips/org/${other}?role=billing`, admin)).statusCode).toBe(403);
    // employees only bill trips to the company
    expect((await h.req("GET", `/api/trips/org/${org}?role=billing`, await h.rider(uuid(), [{ r: "CORPORATE_EMPLOYEE", org }]))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/trips/org/${org}`, admin)).statusCode).toBe(400); // role is required
  });

  it("a fleet owner sees the trips driven in the fleet's cars; finance sees any org", async () => {
    const city = freshCity();
    const fleet = uuid();
    const owner = await h.rider(uuid(), [{ r: "FLEET_OWNER", org: fleet }]);
    const t1 = await seed(city, { fleetOrgId: fleet, createdAt: new Date("2026-10-20T10:00:00Z") });
    const t2 = await seed(city, { fleetOrgId: fleet, status: "matched", createdAt: new Date("2026-10-20T11:00:00Z") });
    await seed(city, { fleetOrgId: uuid() });
    await seed(city); // an owner-driver's car

    expect((await all(`/api/trips/org/${fleet}?role=fleet`, owner)).map((t) => t.id)).toEqual([t2.id, t1.id]);
    // nothing is billed to a fleet
    expect(await all(`/api/trips/org/${fleet}?role=billing`, owner)).toEqual([]);
    expect((await h.req("GET", `/api/trips/org/${uuid()}?role=fleet`, owner)).statusCode).toBe(403);
    // a fleet driver (attribute role) holds no trip:read
    expect((await h.req("GET", `/api/trips/org/${fleet}?role=fleet`, await h.rider(uuid(), [{ r: "FLEET_DRIVER", org: fleet }]))).statusCode).toBe(403);
    // city staff hold trip:read by city, not by org
    expect((await h.req("GET", `/api/trips/org/${fleet}?role=fleet`, await h.staff([{ r: "DISPATCHER", city }]))).statusCode).toBe(403);

    const finance = await h.staff([{ r: "FINANCE_OFFICER" }]);
    const staffView = await all(`/api/trips/org/${fleet}?role=fleet`, finance);
    expect(staffView.map((t) => t.id)).toEqual([t2.id, t1.id]);
    expect(staffView[0]).toHaveProperty("flags");
  });
});

describe("daily trip report", () => {
  it("counts per Addis day: statuses, completion, cancellations, time to match, GMV, channels and vehicle types", async () => {
    const city = freshCity();
    // 2026-10-20 Addis = 2026-10-19T21:00Z .. 2026-10-20T21:00Z
    const d20 = new Date("2026-10-20T06:00:00Z");
    const d20late = new Date("2026-10-20T20:30:00Z"); // 23:30 Addis, still the 20th
    const d21early = new Date("2026-10-20T21:30:00Z"); // 00:30 Addis on the 21st
    await seed(city, { createdAt: d20, fareFinalMinor: 30_000, matchedAfterSeconds: 20 });
    await seed(city, { createdAt: d20late, fareFinalMinor: 10_000, matchedAfterSeconds: 40, vehicleType: "comfort", channel: "PHONE" });
    await seed(city, { createdAt: d20, status: "cancelled", cancelledBy: "RIDER", cancelReason: "CHANGED_PLANS", cancelFeeMinor: 3000 });
    await seed(city, { createdAt: d20, status: "cancelled", cancelledBy: "SYSTEM", cancelReason: "NO_DRIVER_FOUND" });
    await seed(city, { createdAt: d21early, status: "matched", matchedAfterSeconds: 60 });
    await seed(freshCity(), { createdAt: d20 });

    const analyst = await h.staff([{ r: "ANALYST", city }]);
    const r = await h.req("GET", `/api/trips/reports/daily?cityId=${city}&from=2026-10-19&to=2026-10-21`, analyst);
    expect(r.statusCode, r.body).toBe(200);
    const rep = r.json<{ cityId: string; from: string; to: string; days: Record<string, unknown>[]; totals: Record<string, unknown> }>();
    expect(rep).toMatchObject({ cityId: city, from: "2026-10-19", to: "2026-10-21" });
    expect(rep.days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(rep.days[0]).toMatchObject({ requested: 0, completionRate: null, avgSecondsToMatch: null, gmvMinor: 0 });
    expect(rep.days[1]).toMatchObject({
      requested: 4, completed: 2, cancelled: 2, active: 0, completionRate: 0.5, avgSecondsToMatch: 30,
      fareMinor: 40_000, cancelFeeMinor: 3000, gmvMinor: 43_000,
      cancellations: { bySide: { RIDER: 1, SYSTEM: 1 }, byReason: { CHANGED_PLANS: 1, NO_DRIVER_FOUND: 1 } },
      byChannel: { APP: { requested: 3, completed: 1 }, PHONE: { requested: 1, completed: 1 } },
      byVehicleType: { economy: { requested: 3, completed: 1 }, comfort: { requested: 1, completed: 1 } },
    });
    expect(rep.days[2]).toMatchObject({ requested: 1, active: 1, completionRate: null, avgSecondsToMatch: 60 });
    // matched trips weigh equally in the total: (20 + 40 + 60) / 3
    expect(rep.totals).toMatchObject({ requested: 5, completed: 2, cancelled: 2, active: 1, avgSecondsToMatch: 40, gmvMinor: 43_000 });

    const csv = await h.req("GET", `/api/trips/reports/daily.csv?cityId=${city}&from=2026-10-19&to=2026-10-21`, analyst);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers["content-disposition"]).toBe(`attachment; filename="trips-${city}-2026-10-19-2026-10-21.csv"`);
    const lines = csv.body.trim().split("\r\n");
    expect(lines).toHaveLength(5); // header, 3 days, total
    const header = lines[0]!.split(",");
    const row20 = Object.fromEntries(lines[2]!.split(",").map((v, i) => [header[i], v]));
    expect(row20).toMatchObject({ date: "2026-10-20", requested: "4", completed: "2", completion_rate: "0.5000", gmv_minor: "43000", cancelled_by_rider: "1", reason_no_driver_found: "1", channel_phone_requested: "1", vehicle_comfort_completed: "1" });
    expect(lines[4]!.startsWith("total,5,2,2,1,")).toBe(true);
  });

  it("report:read in the city, or everywhere for the all-cities report", async () => {
    const city = freshCity();
    await seed(city, { createdAt: new Date("2026-10-20T06:00:00Z") });
    const q = `from=2026-10-20&to=2026-10-20`;
    const analyst = await h.staff([{ r: "ANALYST", city }]);
    expect((await h.req("GET", `/api/trips/reports/daily?cityId=${freshCity()}&${q}`, analyst)).statusCode).toBe(403);
    expect((await h.req("GET", `/api/trips/reports/daily?${q}`, analyst)).statusCode).toBe(403);
    expect((await h.req("GET", `/api/trips/reports/daily.csv?${q}`, analyst)).statusCode).toBe(403);
    // call center agents read trips but not reports
    expect((await h.req("GET", `/api/trips/reports/daily?cityId=${city}&${q}`, await h.staff([{ r: "CALL_CENTER_AGENT", city }]))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/trips/reports/daily?cityId=${city}&${q}`, await h.rider())).statusCode).toBe(403);
    expect((await h.req("GET", `/api/trips/reports/daily?cityId=${city}&from=2026-01-01&to=2026-12-31`, analyst)).json()).toMatchObject({ error: "invalid_range" });

    const auditor = await h.staff([{ r: "AUDITOR" }]);
    const everywhere = await h.req("GET", `/api/trips/reports/daily?${q}`, auditor);
    expect(everywhere.statusCode).toBe(200);
    expect(everywhere.json()).toMatchObject({ cityId: null });
    expect(everywhere.json<{ totals: { requested: number } }>().totals.requested).toBeGreaterThanOrEqual(1);
    // the default range is the last 7 days up to today (Addis)
    const def = await h.req("GET", `/api/trips/reports/daily?cityId=${city}`, analyst);
    expect(def.json<{ days: unknown[] }>().days).toHaveLength(7);
  });
});
