import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CITY, createHarness, png, uuid, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

describe("driver application (workflow 02)", () => {
  it("encrypts the licence and refuses a second application with the same licence", async () => {
    const a = await h.person();
    const body = { fullName: "Abebe Kebede", licenseNumber: "AB 99001", cityId: CITY };
    const r = await h.ok<{ licenseNumber: string; status: string }>(h.req("POST", "/api/fleet/drivers/apply", a, body), 201);
    expect(r).toMatchObject({ licenseNumber: "AB99001", status: "APPLIED" });
    const row = await h.c.db.driverProfile.findUniqueOrThrow({ where: { userId: a.id } });
    expect(Buffer.from(row.licenseNumber).toString("latin1")).not.toContain("AB99001");

    const b = await h.person();
    const dup = await h.req("POST", "/api/fleet/drivers/apply", b, { ...body, licenseNumber: "ab-99001" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: "licence_registered" });
    expect((await h.req("POST", "/api/fleet/drivers/apply", a, { ...body, licenseNumber: "XY12345" })).json()).toMatchObject({ error: "already_applied" });
  });

  it("uploads need the expiry date where documents lapse, and a file that matches the ticket", async () => {
    const a = await h.person();
    await h.ok(h.req("POST", "/api/fleet/drivers/apply", a, { fullName: "Hana G", licenseNumber: `ZZ${Date.now()}`.slice(0, 12), cityId: CITY }), 201);
    await expect(h.upload(a, "DRIVER", a.id, "LICENSE")).rejects.toThrow(/expiry_required/);

    const body = png();
    const t = await h.ok<{ uploadUrl: string; ticket: string; headers: Record<string, string> }>(h.req("POST", "/api/fleet/documents/upload-url", a, {
      subjectType: "DRIVER", subjectId: a.id, kind: "PHOTO", contentType: "image/png", sizeBytes: body.length, sha256: "0".repeat(64),
    }));
    expect((await h.app.inject({ method: "PUT", url: t.uploadUrl, payload: Buffer.concat([body, body]), headers: t.headers })).statusCode).toBe(400);
    await h.app.inject({ method: "PUT", url: t.uploadUrl, payload: body, headers: t.headers });
    const confirm = await h.req("POST", "/api/fleet/documents", a, { ticket: t.ticket });
    expect(confirm.json()).toMatchObject({ error: "upload_mismatch" }); // hash differs

    // someone else can't upload to this application, nor use this ticket
    const other = await h.person();
    expect((await h.req("POST", "/api/fleet/documents/upload-url", other, { subjectType: "DRIVER", subjectId: a.id, kind: "PHOTO", contentType: "image/png", sizeBytes: 10, sha256: "0".repeat(64) })).statusCode).toBe(403);
    expect((await h.req("POST", "/api/fleet/documents", other, { ticket: t.ticket })).json()).toMatchObject({ error: "invalid_ticket" });
  });

  it("submit → city queue → document review → approval grants DRIVER through auth-service", async () => {
    const a = await h.applicant();
    const off = await h.officer();
    expect((await h.req("POST", "/api/fleet/drivers/me/submit", a)).statusCode).toBe(200);
    const q = await h.ok<{ drivers: { userId: string; pendingDocuments: number; licenseNumber: string }[] }>(h.req("GET", `/api/fleet/review/queue?cityId=${CITY}`, off));
    const item = q.drivers.find((d) => d.userId === a.id)!;
    expect(item.pendingDocuments).toBe(3);
    expect(item.licenseNumber).toMatch(/^•••• /);

    // can't approve the driver before the documents
    expect((await h.req("POST", `/api/fleet/drivers/${a.id}/approve`, off)).json()).toMatchObject({ error: "documents_not_approved" });
    // another city's officer can't see or act
    const elsewhere = await h.officer("dire-dawa");
    expect((await h.req("POST", `/api/fleet/drivers/${a.id}/approve`, elsewhere)).statusCode).toBe(403);

    await h.approveDocs(off, "DRIVER", a.id);
    h.authState.down = true;
    expect((await h.req("POST", `/api/fleet/drivers/${a.id}/approve`, off)).statusCode).toBe(503);
    expect((await h.c.db.driverProfile.findUniqueOrThrow({ where: { userId: a.id } })).status).toBe("PENDING_REVIEW"); // rolled back
    h.authState.down = false;

    const ok = await h.ok<{ status: string }>(h.req("POST", `/api/fleet/drivers/${a.id}/approve`, off));
    expect(ok.status).toBe("ACTIVE");
    expect(h.roleCalls).toContainEqual({ userId: a.id, active: true });
    expect(await h.outbox(a.id, "driver.activated")).toHaveLength(1);
  });

  it("a rejected document sends the application back; the officer's views are audited", async () => {
    const a = await h.applicant();
    await h.ok(h.req("POST", "/api/fleet/drivers/me/submit", a));
    const off = await h.officer();
    const docs = await h.ok<{ documents: { kind: string; document: { id: string } }[] }>(h.req("GET", `/api/fleet/documents?subjectType=DRIVER&subjectId=${a.id}`, off));
    const photo = docs.documents.find((d) => d.kind === "PHOTO")!.document.id;

    const view = await h.ok<{ url: string }>(h.req("GET", `/api/fleet/documents/${photo}/url`, off));
    expect((await h.app.inject({ method: "GET", url: view.url })).statusCode).toBe(200);
    expect((await h.outbox(off.id, "audit.recorded")).some((e) => e.action === "document:view")).toBe(true);

    expect((await h.req("POST", `/api/fleet/documents/${photo}/review`, off, { decision: "REJECT" })).json()).toMatchObject({ error: "reason_required" });
    await h.ok(h.req("POST", `/api/fleet/documents/${photo}/review`, off, { decision: "REJECT", reason: "Photo is blurry" }));
    const back = await h.ok<{ status: string; reviewNote: string }>(h.req("POST", `/api/fleet/drivers/${a.id}/request-changes`, off, { reason: "Retake the photo in daylight" }));
    expect(back).toMatchObject({ status: "APPLIED", reviewNote: "Retake the photo in daylight" });

    // the driver must replace the rejected photo before submitting again
    expect((await h.req("POST", "/api/fleet/drivers/me/submit", a)).json()).toMatchObject({ error: "documents_missing" });
    await h.upload(a, "DRIVER", a.id, "PHOTO");
    expect((await h.req("POST", "/api/fleet/drivers/me/submit", a)).statusCode).toBe(200);
    const me = await h.ok<{ driver: { documents: { kind: string; document: { status: string } }[] } }>(h.req("GET", "/api/fleet/drivers/me", a));
    expect(me.driver.documents.find((d) => d.kind === "PHOTO")!.document.status).toBe("PENDING");
  });
});

describe("vehicles and sessions (workflow 04)", () => {
  it("an owner-driver drives their own verified car; one session per car and per driver", async () => {
    const d = await h.activeDriver([{ r: "RIDER" }, { r: "DRIVER" }]);
    const v = await h.verifiedVehicle(d, { ownerType: "INDIVIDUAL" });
    const started = await h.ok<{ id: string; vehicleId: string }>(h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id }), 201);
    expect(started.vehicleId).toBe(v.id);
    const [online] = await h.outbox(d.id, "driver.online");
    expect(online).toMatchObject({ driverId: d.id, vehicleId: v.id, vehicleType: "economy", cityId: CITY, beneficiaryId: d.id, cashAllowed: true });
    // the same request again returns the same session
    expect((await h.ok<{ id: string }>(h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id }), 201)).id).toBe(started.id);

    const other = await h.activeDriver([{ r: "RIDER" }, { r: "DRIVER" }]);
    expect((await h.req("POST", "/api/fleet/sessions", other, { vehicleId: v.id })).json()).toMatchObject({ error: "not_your_vehicle" });

    await h.ok(h.req("DELETE", "/api/fleet/sessions/current", d));
    expect((await h.outbox(d.id, "driver.offline")).at(-1)).toMatchObject({ reason: "DRIVER" });
    expect((await h.ok<{ session: null }>(h.req("GET", "/api/fleet/sessions/current", d))).session).toBeNull();

    // the balance (payment-service): cash-blocked goes online without cash trips; blocked can't go online
    h.balanceStates.set(d.id, "CASH_BLOCKED");
    await h.ok(h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id }), 201);
    expect((await h.outbox(d.id, "driver.online")).at(-1)).toMatchObject({ balanceState: "CASH_BLOCKED", cashAllowed: false });
    await h.ok(h.req("DELETE", "/api/fleet/sessions/current", d));
    h.balanceStates.set(d.id, "BLOCKED");
    expect((await h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id })).json()).toMatchObject({ error: "balance_blocked" });
    h.balanceStates.delete(d.id);
  });

  it("plates are unique; vehicle types and seats are checked", async () => {
    const d = await h.activeDriver();
    const body = h.car({ ownerType: "INDIVIDUAL", plateNumber: "3-B77777" });
    await h.ok(h.req("POST", "/api/fleet/vehicles", d, body), 201);
    const again = await h.req("POST", "/api/fleet/vehicles", await h.activeDriver(), { ...body, plateNumber: " 3-b77777 " });
    expect(again.json()).toMatchObject({ error: "plate_registered" });
    expect((await h.req("POST", "/api/fleet/vehicles", d, h.car({ ownerType: "INDIVIDUAL", vehicleType: "minivan", seats: 4 }))).json()).toMatchObject({ error: "invalid_seats" });
    expect((await h.req("POST", "/api/fleet/vehicles", await h.person(), h.car({ ownerType: "INDIVIDUAL" }))).json()).toMatchObject({ error: "not_a_driver" });
  });

  it("fleet cars: verified company only, members only, authorised drivers only (V7)", async () => {
    const pending = h.fleetOrg("PENDING");
    const pendingOwner = await h.person([{ r: "FLEET_OWNER", org: pending }]);
    expect((await h.req("POST", "/api/fleet/vehicles", pendingOwner, h.car({ ownerType: "ORGANIZATION", ownerOrgId: pending }))).json()).toMatchObject({ error: "org_not_verified" });

    const org = h.fleetOrg();
    const owner = await h.person([{ r: "FLEET_OWNER", org }]);
    // another company's owner can't add cars to this fleet
    const stranger = await h.person([{ r: "FLEET_OWNER", org: h.fleetOrg() }]);
    expect((await h.req("POST", "/api/fleet/vehicles", stranger, h.car({ ownerType: "ORGANIZATION", ownerOrgId: org }))).statusCode).toBe(403);

    const v = await h.verifiedVehicle(owner, { ownerType: "ORGANIZATION", ownerOrgId: org });
    // city staff see a company's cars in their city (the staff Companies page); not without the city
    const off = await h.officer();
    const listed = await h.ok<{ vehicles: { id: string }[] }>(h.req("GET", `/api/fleet/vehicles?ownerOrgId=${org}&cityId=addis-ababa`, off));
    expect(listed.vehicles.map((x) => x.id)).toContain(v.id);
    expect((await h.req("GET", `/api/fleet/vehicles?ownerOrgId=${org}`, off)).statusCode).toBe(403);
    expect((await h.req("GET", `/api/fleet/vehicles?ownerOrgId=${org}&cityId=addis-ababa`, await h.officer("dire-dawa"))).statusCode).toBe(403);
    const driver = await h.activeDriver([{ r: "RIDER" }, { r: "DRIVER" }, { r: "FLEET_DRIVER", org }]);

    expect((await h.req("POST", `/api/fleet/vehicles/${v.id}/authorizations`, owner, { driverUserId: driver.id })).json()).toMatchObject({ error: "not_a_fleet_driver" });
    h.addMember(org, driver.id);
    expect((await h.req("POST", "/api/fleet/sessions", driver, { vehicleId: v.id })).json()).toMatchObject({ error: "not_authorized_for_vehicle" });
    await h.ok(h.req("POST", `/api/fleet/vehicles/${v.id}/authorizations`, owner, { driverUserId: driver.id }), 201);

    const picker = await h.ok<{ vehicles: { id: string; canDrive: boolean }[] }>(h.req("GET", "/api/fleet/drivers/me/vehicles", driver));
    expect(picker.vehicles).toContainEqual(expect.objectContaining({ id: v.id, canDrive: true }));
    await h.ok(h.req("POST", "/api/fleet/sessions", driver, { vehicleId: v.id }), 201);
    expect((await h.outbox(driver.id, "driver.online")).at(-1)).toMatchObject({ fleetOrgId: org, beneficiaryId: org });

    // a second authorised driver can't take the car while it's in use
    const second = await h.activeDriver([{ r: "RIDER" }, { r: "DRIVER" }, { r: "FLEET_DRIVER", org }]);
    h.addMember(org, second.id);
    await h.ok(h.req("POST", `/api/fleet/vehicles/${v.id}/authorizations`, owner, { driverUserId: second.id }), 201);
    expect((await h.req("POST", "/api/fleet/sessions", second, { vehicleId: v.id })).json()).toMatchObject({ error: "vehicle_in_use" });

    // the overview shows the car, who's driving and the drivers' onboarding status
    const overview = await h.ok<{ vehicles: { id: string; session: { driverUserId: string } | null }[]; drivers: { userId: string; driver: { status: string } }[] }>(
      h.req("GET", `/api/fleet/organizations/${org}/overview?members=${driver.id},${second.id},${uuid()}`, owner));
    expect(overview.vehicles[0]!.session?.driverUserId).toBe(driver.id);
    expect(overview.drivers.map((x) => x.userId).sort()).toEqual([driver.id, second.id].sort());

    // revoking ends the session
    await h.ok(h.req("DELETE", `/api/fleet/vehicles/${v.id}/authorizations/${driver.id}`, owner));
    expect((await h.outbox(driver.id, "driver.offline")).at(-1)).toMatchObject({ reason: "VEHICLE_UNAVAILABLE" });
    await h.ok(h.req("POST", "/api/fleet/sessions", second, { vehicleId: v.id }), 201);
  });

  it("an expired insurance suspends the car and ends its session (V10); a suspended driver goes offline", async () => {
    const d = await h.activeDriver([{ r: "RIDER" }, { r: "DRIVER" }]);
    const v = await h.verifiedVehicle(d, { ownerType: "INDIVIDUAL" });
    await h.ok(h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id }), 201);

    const insurance = await h.c.db.document.findFirstOrThrow({ where: { subjectId: v.id, kind: "INSURANCE", status: "APPROVED" } });
    await h.c.db.document.update({ where: { id: insurance.id }, data: { expiresAt: new Date(Date.UTC(2020, 0, 1)) } });
    expect(await h.c.fleet.expireDocuments()).toBeGreaterThanOrEqual(1);
    const car = await h.ok<{ status: string; statusReason: string; missingForSubmit: string[] }>(h.req("GET", `/api/fleet/vehicles/${v.id}`, d));
    expect(car).toMatchObject({ status: "SUSPENDED", statusReason: "DOCUMENT_EXPIRED", missingForSubmit: ["INSURANCE"] });
    expect((await h.outbox(d.id, "driver.offline")).at(-1)).toMatchObject({ reason: "VEHICLE_UNAVAILABLE" });

    // renewing: upload the new insurance, resubmit, officer approves
    await h.upload(d, "VEHICLE", v.id, "INSURANCE", { expiresAt: h.future() });
    await h.ok(h.req("POST", `/api/fleet/vehicles/${v.id}/submit`, d));
    const off = await h.officer();
    await h.approveDocs(off, "VEHICLE", v.id);
    await h.ok(h.req("POST", `/api/fleet/vehicles/${v.id}/approve`, off));
    await h.ok(h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id }), 201);

    const safety = await h.staff([{ r: "SAFETY_OFFICER", city: CITY }]);
    const dispatcher = await h.staff([{ r: "DISPATCHER", city: CITY }]);
    expect((await h.req("POST", `/api/fleet/drivers/${d.id}/suspend`, dispatcher, { reason: "Repeated complaints" })).statusCode).toBe(403);
    await h.ok(h.req("POST", `/api/fleet/drivers/${d.id}/suspend`, safety, { reason: "Repeated complaints from riders" }));
    expect(h.roleCalls.at(-1)).toEqual({ userId: d.id, active: false }); // the DRIVER role goes with it
    expect((await h.outbox(d.id, "driver.offline")).at(-1)).toMatchObject({ reason: "SUSPENDED" });
    expect((await h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id })).json()).toMatchObject({ error: "driver_not_active" });
    await h.ok(h.req("POST", `/api/fleet/drivers/${d.id}/reinstate`, safety, { reason: "Investigation closed, no fault" }));
    expect(h.roleCalls.at(-1)).toEqual({ userId: d.id, active: true });
    await h.ok(h.req("POST", "/api/fleet/sessions", d, { vehicleId: v.id }), 201);
  });
});
