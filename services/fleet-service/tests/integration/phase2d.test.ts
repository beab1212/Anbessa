// Vehicle ownership transfer (V9, maker–checker), manual vehicle suspension, and a fleet's
// expiring documents for staff.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CITY, createHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

type Transfer = { id: string; status: string; makerId: string | null; to: { type: string; id: string; name: string | null } };

/** An active owner-driver online in their verified car. */
async function ownerDriverOnline() {
  const d = await h.activeDriver([{ r: "RIDER" }, { r: "DRIVER" }]);
  const v = await h.verifiedVehicle(d, { ownerType: "INDIVIDUAL" });
  await h.ok(h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id }), 201);
  return { d, v };
}

describe("manual vehicle suspension", () => {
  it("onboarding or safety (driver:suspend in the city) takes a car off the road; the session ends; reinstating needs valid documents", async () => {
    const { d, v } = await ownerDriverOnline();
    const safety = await h.staff([{ r: "SAFETY_OFFICER", city: CITY }]);
    const elsewhere = await h.staff([{ r: "SAFETY_OFFICER", city: "hawassa" }]);
    const dispatcher = await h.staff([{ r: "DISPATCHER", city: CITY }]);
    const reason = { reason: "reported unsafe brakes, ticket 4411" };
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/suspend`, elsewhere, reason)).statusCode).toBe(403);
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/suspend`, dispatcher, reason)).statusCode).toBe(403);
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/suspend`, d, reason)).statusCode).toBe(403);
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/suspend`, safety, { reason: "short" })).statusCode).toBe(400);

    const s = await h.ok<{ status: string; statusReason: string; reviewNote: string }>(h.req("POST", `/api/fleet/vehicles/${v.id}/suspend`, safety, reason));
    expect(s).toMatchObject({ status: "SUSPENDED", statusReason: "SAFETY", reviewNote: reason.reason });
    expect((await h.ok<{ session: null }>(h.req("GET", "/api/fleet/sessions/current", d))).session).toBeNull();
    expect(await h.outbox(d.id, "driver.offline")).toEqual([expect.objectContaining({ reason: "VEHICLE_UNAVAILABLE" })]);
    expect(await h.outbox(v.id, "vehicle.suspended")).toEqual([expect.objectContaining({ byUserId: safety.id, reason: reason.reason })]);
    expect((await h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id })).json()).toMatchObject({ error: "vehicle_not_verified" });
    // idempotent
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/suspend`, safety, reason)).statusCode).toBe(200);

    // an onboarding officer may lift it too, with a reason
    const off = await h.officer();
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/reinstate`, dispatcher, { reason: "brakes repaired and checked" })).statusCode).toBe(403);
    const r = await h.ok<{ status: string; statusReason: string | null }>(h.req("POST", `/api/fleet/vehicles/${v.id}/reinstate`, off, { reason: "brakes repaired and checked" }));
    expect(r).toMatchObject({ status: "VERIFIED", statusReason: null });
    expect(await h.outbox(v.id, "vehicle.reinstated")).toEqual([expect.objectContaining({ byUserId: off.id })]);
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/reinstate`, off, { reason: "brakes repaired and checked" })).json()).toMatchObject({ error: "invalid_state" });
    await h.ok(h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id }), 201);
    const audits = (await h.c.db.outbox.findMany({ where: { topic: "audit.recorded" } })).map((a) => a.payload as { action: string; resource: { id: string } });
    expect(audits.filter((a) => a.resource.id === v.id).map((a) => a.action)).toEqual(expect.arrayContaining(["vehicle:suspend", "vehicle:reinstate"]));
  });

  it("refuses to reinstate while a document is no longer valid", async () => {
    const d = await h.activeDriver([{ r: "RIDER" }, { r: "DRIVER" }]);
    const v = await h.verifiedVehicle(d, { ownerType: "INDIVIDUAL" });
    const off = await h.officer();
    await h.ok(h.req("POST", `/api/fleet/vehicles/${v.id}/suspend`, off, { reason: "registration looks altered", category: "ONBOARDING" }));
    const ins = await h.c.db.document.findFirstOrThrow({ where: { subjectId: v.id, kind: "INSURANCE" } });
    await h.c.db.document.update({ where: { id: ins.id }, data: { status: "REJECTED" } });
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/reinstate`, off, { reason: "checked the original papers" })).json()).toMatchObject({ error: "documents_not_approved" });
  });
});

describe("ownership transfer (V9, maker–checker)", () => {
  it("owner-driver sells to a fleet: the owner asks, one officer proposes, a second approves; sessions end and documents are checked again", async () => {
    const { d, v } = await ownerDriverOnline();
    const org = h.fleetOrg();
    const fleetOwner = await h.person([{ r: "FLEET_OWNER", org }]);
    const stranger = await h.person([{ r: "RIDER" }, { r: "DRIVER" }]);
    const body = { toOwnerType: "ORGANIZATION", toOwnerId: org, reason: "sold to Selam Transport, contract 77" };

    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, stranger, body)).statusCode).toBe(403);
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, d, { ...body, toOwnerId: h.fleetOrg("PENDING") })).json()).toMatchObject({ error: "org_not_verified" });
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, d, { ...body, toOwnerType: "INDIVIDUAL", toOwnerId: d.id })).json()).toMatchObject({ error: "same_owner" });
    const asked = await h.ok<Transfer>(h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, d, body), 201);
    expect(asked).toMatchObject({ status: "REQUESTED", makerId: null });
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, d, body)).json()).toMatchObject({ error: "transfer_pending" });

    const a = await h.officer();
    const b = await h.officer();
    const south = await h.officer("hawassa");
    // an owner's request must be proposed before anyone approves it
    expect((await h.req("POST", `/api/fleet/transfers/${asked.id}/approve`, a, {})).json()).toMatchObject({ error: "not_proposed" });
    expect((await h.req("POST", `/api/fleet/transfers/${asked.id}/endorse`, south, {})).statusCode).toBe(403);
    expect((await h.req("POST", `/api/fleet/transfers/${asked.id}/endorse`, d, {})).statusCode).toBe(403);
    await h.ok(h.req("POST", `/api/fleet/transfers/${asked.id}/endorse`, a, { note: "contract checked" }));
    expect((await h.req("POST", `/api/fleet/transfers/${asked.id}/approve`, a, {})).json()).toMatchObject({ error: "maker_is_checker" });
    expect((await h.req("POST", `/api/fleet/transfers/${asked.id}/approve`, south, {})).statusCode).toBe(403);

    // staff see it in the city list; the receiving fleet sees it coming
    const cityList = await h.ok<{ transfers: Transfer[] }>(h.req("GET", `/api/fleet/transfers?cityId=${CITY}&status=PENDING`, b));
    expect(cityList.transfers.map((t) => t.id)).toContain(asked.id);
    const incoming = await h.ok<{ transfers: Transfer[] }>(h.req("GET", `/api/fleet/transfers?ownerOrgId=${org}`, fleetOwner));
    expect(incoming.transfers.map((t) => t.id)).toEqual([asked.id]);
    expect((await h.req("GET", `/api/fleet/transfers?ownerOrgId=${org}`, stranger)).statusCode).toBe(403);

    const done = await h.ok<Transfer>(h.req("POST", `/api/fleet/transfers/${asked.id}/approve`, b, { note: "second check done" }));
    expect(done.status).toBe("EXECUTED");
    const row = await h.c.db.vehicle.findUniqueOrThrow({ where: { id: v.id } });
    expect(row).toMatchObject({ ownerType: "ORGANIZATION", ownerOrgId: org, ownerUserId: null, status: "DRAFT", statusReason: "TRANSFERRED" });
    expect((await h.ok<{ session: null }>(h.req("GET", "/api/fleet/sessions/current", d))).session).toBeNull();
    const docs = await h.c.db.document.findMany({ where: { subjectId: v.id }, orderBy: { kind: "asc" } });
    expect(Object.fromEntries(docs.map((x) => [x.kind, x.status]))).toEqual({ INSPECTION: "PENDING", INSURANCE: "PENDING", REGISTRATION: "SUPERSEDED" });
    expect(await h.outbox(v.id, "vehicle.transferred")).toEqual([expect.objectContaining({
      transferId: asked.id, fromOwnerType: "INDIVIDUAL", fromOwnerId: d.id, toOwnerType: "ORGANIZATION", toOwnerId: org, requestedBy: d.id, makerId: a.id, byUserId: b.id,
    })]);

    // the old owner can't drive or act on it; the fleet owns it and uploads the new registration
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/retire`, d)).statusCode).toBe(403);
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/submit`, fleetOwner)).json()).toMatchObject({ error: "documents_missing" });
    await h.upload(fleetOwner, "VEHICLE", v.id, "REGISTRATION");
    await h.ok(h.req("POST", `/api/fleet/vehicles/${v.id}/submit`, fleetOwner));
    await h.approveDocs(a, "VEHICLE", v.id);
    await h.ok(h.req("POST", `/api/fleet/vehicles/${v.id}/approve`, a));
    const history = await h.ok<{ transfers: Transfer[] }>(h.req("GET", `/api/fleet/vehicles/${v.id}/transfers`, fleetOwner));
    expect(history.transfers.map((t) => t.status)).toEqual(["EXECUTED"]);
  });

  it("fleet to a driver started by staff (PENDING at once); fleet authorisations are revoked; between fleets; reject and withdraw", async () => {
    const org = h.fleetOrg();
    const owner = await h.person([{ r: "FLEET_OWNER", org }]);
    const v = await h.verifiedVehicle(owner, { ownerType: "ORGANIZATION", ownerOrgId: org });
    const driver = await h.activeDriver([{ r: "RIDER" }, { r: "DRIVER" }, { r: "FLEET_DRIVER", org }]);
    h.addMember(org, driver.id);
    await h.ok(h.req("POST", `/api/fleet/vehicles/${v.id}/authorizations`, owner, { driverUserId: driver.id }), 201);

    const a = await h.officer();
    const b = await h.officer();
    const notADriver = await h.person();
    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, a, { toOwnerType: "INDIVIDUAL", toOwnerId: notADriver.id, reason: "selling the car to its driver" })).json()).toMatchObject({ error: "not_a_driver" });
    const t = await h.ok<Transfer>(h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, a, { toOwnerType: "INDIVIDUAL", toOwnerId: driver.id, reason: "selling the car to its driver" }), 201);
    expect(t).toMatchObject({ status: "PENDING", makerId: a.id, to: { type: "INDIVIDUAL", id: driver.id, name: "Abebe Kebede" } });

    // a second officer rejects; the maker can't reject their own (they withdraw)
    expect((await h.req("POST", `/api/fleet/transfers/${t.id}/reject`, a, { reason: "changed my mind about it" })).json()).toMatchObject({ error: "maker_is_checker" });
    const rejected = await h.ok<Transfer>(h.req("POST", `/api/fleet/transfers/${t.id}/reject`, b, { reason: "sale contract not signed by the company" }));
    expect(rejected.status).toBe("REJECTED");
    expect((await h.req("POST", `/api/fleet/transfers/${t.id}/approve`, b, {})).json()).toMatchObject({ error: "not_open" });

    // the fleet asks to hand the car to another fleet, then withdraws; then asks again and it goes through
    const other = h.fleetOrg();
    const ask = { toOwnerType: "ORGANIZATION", toOwnerId: other, reason: "moving the car to our sister company" };
    const t2 = await h.ok<Transfer>(h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, owner, ask), 201);
    expect((await h.req("POST", `/api/fleet/transfers/${t2.id}/cancel`, driver)).statusCode).toBe(403);
    expect((await h.ok<Transfer>(h.req("POST", `/api/fleet/transfers/${t2.id}/cancel`, owner))).status).toBe("CANCELLED");

    const t3 = await h.ok<Transfer>(h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, a, { toOwnerType: "INDIVIDUAL", toOwnerId: driver.id, reason: "selling the car to its driver" }), 201);
    await h.ok(h.req("POST", `/api/fleet/transfers/${t3.id}/approve`, b, {}));
    const auth = await h.c.db.vehicleAuthorization.findUniqueOrThrow({ where: { vehicleId_driverUserId: { vehicleId: v.id, driverUserId: driver.id } } });
    expect(auth.status).toBe("REVOKED");
    expect(await h.c.db.vehicle.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ ownerType: "INDIVIDUAL", ownerUserId: driver.id, ownerOrgId: null });
    // the new owner-driver sees it among their cars and its transfer history
    const me = await h.ok<{ vehicles: { id: string }[] }>(h.req("GET", "/api/fleet/drivers/me", driver));
    expect(me.vehicles.map((x) => x.id)).toContain(v.id);
    const mine = await h.ok<{ transfers: Transfer[] }>(h.req("GET", "/api/fleet/transfers", driver));
    expect(mine.transfers.map((x) => x.id)).toContain(t3.id);
  });

  it("undecided transfers expire after 7 days", async () => {
    const d = await h.activeDriver([{ r: "RIDER" }, { r: "DRIVER" }]);
    const v = await h.verifiedVehicle(d, { ownerType: "INDIVIDUAL" });
    const t = await h.ok<Transfer>(h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, d, { toOwnerType: "ORGANIZATION", toOwnerId: h.fleetOrg(), reason: "selling it to a fleet company" }), 201);
    const a = await h.officer();
    const real = h.clock.now;
    h.clock.now += 8 * 86_400_000;
    try {
      expect((await h.req("POST", `/api/fleet/transfers/${t.id}/endorse`, a, {})).json()).toMatchObject({ error: "expired" });
      expect((await h.c.db.vehicleTransfer.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("EXPIRED");
      expect(await h.c.fleet.expireTransfers()).toBeGreaterThanOrEqual(0);
    } finally {
      h.clock.now = real;
    }
    // a new one may be asked
    await h.ok(h.req("POST", `/api/fleet/vehicles/${v.id}/transfers`, d, { toOwnerType: "ORGANIZATION", toOwnerId: h.fleetOrg(), reason: "selling it to a fleet company" }), 201);
  });
});

describe("a fleet's expiring documents (staff)", () => {
  it("lists the company's and its cars' documents that expired or expire within the window, for document:read in its city", async () => {
    const org = h.fleetOrg();
    const owner = await h.person([{ r: "FLEET_OWNER", org }]);
    const soon = await h.verifiedVehicle(owner, { ownerType: "ORGANIZATION", ownerOrgId: org });
    const later = await h.verifiedVehicle(owner, { ownerType: "ORGANIZATION", ownerOrgId: org });
    const ins = await h.c.db.document.findFirstOrThrow({ where: { subjectId: soon.id, kind: "INSURANCE" } });
    await h.c.db.document.update({ where: { id: ins.id }, data: { expiresAt: new Date(`${h.future(10)}T00:00:00Z`) } });
    const insp = await h.c.db.document.findFirstOrThrow({ where: { subjectId: later.id, kind: "INSPECTION" } });
    await h.c.db.document.update({ where: { id: insp.id }, data: { status: "EXPIRED", expiresAt: new Date(`${h.future(-3)}T00:00:00Z`) } });

    const off = await h.officer();
    const r = await h.ok<{ documents: { id: string; daysLeft: number; vehicle: { plateNumber: string } | null }[] }>(h.req("GET", `/api/fleet/organizations/${org}/expiring-documents?days=30`, off));
    expect(r.documents.map((x) => x.id)).toEqual([insp.id, ins.id]);
    expect(r.documents[0]).toMatchObject({ daysLeft: -3, vehicle: { plateNumber: expect.any(String) } });
    expect(r.documents[1]!.daysLeft).toBe(10);
    expect((await h.ok<{ documents: unknown[] }>(h.req("GET", `/api/fleet/organizations/${org}/expiring-documents?days=5`, off))).documents).toHaveLength(1);

    expect((await h.req("GET", `/api/fleet/organizations/${org}/expiring-documents`, await h.officer("hawassa"))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/fleet/organizations/${org}/expiring-documents`, await h.staff([{ r: "SAFETY_OFFICER", city: CITY }]))).statusCode).toBe(403);
    expect((await h.req("GET", `/api/fleet/organizations/${org}/expiring-documents`, owner)).statusCode).toBe(403);
    expect((await h.req("GET", `/api/fleet/organizations/${crypto.randomUUID()}/expiring-documents`, off)).statusCode).toBe(404);
  });
});
