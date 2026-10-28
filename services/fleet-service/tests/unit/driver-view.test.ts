// What a fleet owner sees of a driver (GET /api/fleet/drivers/:userId?orgId=): only their own fleet.

import { describe, expect, it } from "vitest";
import { parseRoleClaims, type Principal } from "@ride-app/shared-authz";
import { createFleetService, fleetOrgIdsOf } from "../../src/fleet/service.js";

const CITY = "addis-ababa";
const DRIVER = "00000000-0000-4000-8000-00000000000d";
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-10-29T08:00:00Z");

const who = (userId: string, claims: object[], audience: Principal["audience"] = "ride-app"): Principal =>
  ({ userId, audience, roles: parseRoleClaims(claims, audience), permissionVersion: 0, amr: ["otp"] }) as Principal;

const vehicle = (id: string, over: Record<string, unknown>) => ({
  id, plateNumber: `3-${id}`, ownerType: "ORGANIZATION", ownerUserId: null, ownerOrgId: null, vehicleType: "economy", make: "Toyota", model: "Vitz",
  year: 2018, color: "White", seats: 4, status: "VERIFIED", statusReason: null, reviewNote: null, cityId: CITY,
  submittedAt: null, verifiedAt: null, version: 0, createdAt: NOW, updatedAt: NOW, ...over,
});
const own = vehicle("own", { ownerType: "INDIVIDUAL", ownerUserId: DRIVER });
const carA = vehicle("car-a", { ownerOrgId: ORG_A });
const carB = vehicle("car-b", { ownerOrgId: ORG_B });
const auth = (v: ReturnType<typeof vehicle>) => ({ vehicleId: v.id, driverUserId: DRIVER, grantedBy: "x", status: "ACTIVE", validUntil: null, createdAt: NOW, revokedAt: null, vehicle: v });

function service(sessionVehicle: string) {
  const db = {
    driverProfile: {
      findUnique: async () => ({
        userId: DRIVER, status: "ACTIVE", statusReason: null, reviewNote: null, fullName: "Abebe", licenseNumber: "x", licenseLast4: "1234",
        cityId: CITY, submittedAt: null, activatedAt: NOW, createdAt: NOW,
      }),
    },
    document: { findMany: async () => [] },
    vehicle: { findMany: async () => [own] },
    vehicleAuthorization: {
      findMany: async ({ where }: { where: { vehicle?: { ownerOrgId?: string } } }) =>
        [auth(carA), auth(carB)].filter((a) => !where.vehicle?.ownerOrgId || a.vehicle.ownerOrgId === where.vehicle.ownerOrgId),
    },
    drivingSession: { findFirst: async () => ({ id: "s1", driverUserId: DRIVER, vehicleId: sessionVehicle, startedAt: NOW, endedAt: null, endReason: null }) },
    $transaction: async () => undefined,
  };
  return createFleetService({
    db: db as never, pii: { decrypt: () => "FULL" } as never, store: {} as never, tickets: {} as never,
    auth: { membership: async (orgId: string) => orgId === ORG_A || orgId === ORG_B } as never,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never, now: () => NOW,
  });
}

describe("getDriver for a fleet owner", () => {
  const ownerA = who("00000000-0000-4000-8000-0000000000c1", [{ r: "FLEET_OWNER", org: ORG_A }]);

  it("lists only this fleet's cars, not the driver's own or another fleet's", async () => {
    const d = await service(carA.id).getDriver(ownerA, DRIVER, ORG_A);
    expect(d.vehicles).toEqual([]);
    expect(d.fleetVehicles.map((v) => v.id)).toEqual([carA.id]);
    expect(d.session?.vehicleId).toBe(carA.id);
  });

  it("hides a session in a car of another fleet", async () => {
    expect((await service(carB.id).getDriver(ownerA, DRIVER, ORG_A)).session).toBeNull();
  });

  it("staff with the city grant and the driver themselves see everything", async () => {
    const staff = who("00000000-0000-4000-8000-0000000000e1", [{ r: "ONBOARDING_OFFICER", g: true }], "ride-admin");
    const all = await service(carB.id).getDriver(staff, DRIVER, ORG_A);
    expect(all.fleetVehicles.map((v) => v.id)).toEqual([carA.id, carB.id]);
    expect(all.vehicles.map((v) => v.id)).toEqual([own.id]);
    const self = await service(carB.id).getDriver(who(DRIVER, [{ r: "DRIVER" }]), DRIVER, ORG_A);
    expect(self.fleetVehicles).toHaveLength(2);
  });
});

describe("fleetOrgIdsOf", () => {
  it("skips roles in a fleet that isn't verified yet", () => {
    const p = who(DRIVER, [{ r: "FLEET_DRIVER", org: ORG_A }, { r: "FLEET_DRIVER", pendingOrg: ORG_B }, { r: "DRIVER" }]);
    expect(fleetOrgIdsOf(p)).toEqual([ORG_A]);
  });
});
