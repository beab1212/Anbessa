import { describe, expect, it } from "vitest";
import { currentDocuments, driveDenial, missingForApproval, missingForSubmit, normalizePlate, type DriveCheck } from "../../src/fleet/rules.js";
import { piiCrypto, signer } from "../../src/lib/crypto.js";

const NOW = new Date("2026-10-27T10:00:00Z");
const doc = (kind: string, status: string, createdAt: string, expiresAt?: string) => ({
  id: `${kind}-${createdAt}`, kind, status, createdAt: new Date(createdAt), expiresAt: expiresAt ? new Date(`${expiresAt}T00:00:00Z`) : null,
});

describe("documents", () => {
  it("the newest non-replaced document of each kind counts", () => {
    const cur = currentDocuments([doc("LICENSE", "SUPERSEDED", "2026-10-01"), doc("LICENSE", "REJECTED", "2026-10-02"), doc("PHOTO", "APPROVED", "2026-10-01")]);
    expect(cur.get("LICENSE")?.status).toBe("REJECTED");
    expect(cur.get("PHOTO")?.status).toBe("APPROVED");
  });

  it("submit needs every kind uploaded and usable; approval needs every kind approved and in date", () => {
    const docs = [doc("LICENSE", "PENDING", "2026-10-01", "2028-01-01"), doc("NATIONAL_ID", "APPROVED", "2026-10-01"), doc("PHOTO", "REJECTED", "2026-10-01")];
    expect(missingForSubmit("DRIVER", docs, NOW)).toEqual(["PHOTO"]);
    expect(missingForApproval("DRIVER", docs, NOW)).toEqual(["LICENSE", "PHOTO"]);
    const lapsed = [doc("REGISTRATION", "APPROVED", "2026-01-01"), doc("INSURANCE", "APPROVED", "2026-01-01", "2026-10-26"), doc("INSPECTION", "APPROVED", "2026-01-01", "2026-10-27")];
    expect(missingForApproval("VEHICLE", lapsed, NOW)).toEqual(["INSURANCE"]); // expires today = still valid today
  });

  it("normalizes plates", () => expect(normalizePlate("  3-a12345   aa ")).toBe("3-A12345 AA"));
});

describe("going online (Role.md §6)", () => {
  const base: DriveCheck = {
    driver: { userId: "d1", status: "ACTIVE" }, driverDocsExpired: false,
    vehicle: { status: "VERIFIED", ownerType: "INDIVIDUAL", ownerUserId: "d1", ownerOrgId: null },
    vehicleBusy: false, fleetOrgIds: [], authorization: null, now: NOW,
  };
  const fleetCar = { status: "VERIFIED", ownerType: "ORGANIZATION", ownerUserId: null, ownerOrgId: "org1" };

  it.each<[string, Partial<DriveCheck>, string | null]>([
    ["own verified car", {}, null],
    ["not active", { driver: { userId: "d1", status: "PENDING_REVIEW" } }, "driver_not_active"],
    ["licence expired", { driverDocsExpired: true }, "documents_expired"],
    ["car not verified", { vehicle: { ...base.vehicle, status: "SUSPENDED" } }, "vehicle_not_verified"],
    ["car in use", { vehicleBusy: true }, "vehicle_in_use"],
    ["someone else's car (V6)", { vehicle: { ...base.vehicle, ownerUserId: "d2" } }, "not_your_vehicle"],
    ["fleet car, not a member (V7)", { vehicle: fleetCar }, "not_in_this_fleet"],
    ["fleet car, member without authorisation", { vehicle: fleetCar, fleetOrgIds: ["org1"] }, "not_authorized_for_vehicle"],
    ["fleet car, authorisation revoked", { vehicle: fleetCar, fleetOrgIds: ["org1"], authorization: { status: "REVOKED", validUntil: null } }, "not_authorized_for_vehicle"],
    ["fleet car, authorisation lapsed", { vehicle: fleetCar, fleetOrgIds: ["org1"], authorization: { status: "ACTIVE", validUntil: new Date("2026-10-27T09:00:00Z") } }, "not_authorized_for_vehicle"],
    ["fleet car, authorised", { vehicle: fleetCar, fleetOrgIds: ["org1"], authorization: { status: "ACTIVE", validUntil: null } }, null],
  ])("%s", (_name, change, expected) => {
    expect(driveDenial({ ...base, ...change })).toBe(expected);
  });
});

describe("crypto", () => {
  const pii = piiCrypto("a".repeat(64), "b".repeat(64));
  it("encrypts licences reversibly and indexes them without spaces or case", () => {
    const blob = pii.encrypt("AA123456");
    expect(Buffer.from(blob).toString("utf8")).not.toContain("AA123456");
    expect(pii.decrypt(blob)).toBe("AA123456");
    expect(Buffer.from(pii.blindIndex("aa-123 456")).equals(Buffer.from(pii.blindIndex("AA123456")))).toBe(true);
  });

  it("signed tickets reject tampering and expiry", () => {
    let t = 0;
    const s = signer("c".repeat(64), () => t);
    const token = s.sign({ key: "x" }, 60);
    expect(s.verify(token)).toEqual({ key: "x" });
    expect(s.verify(token.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    t = 61_000;
    expect(s.verify(token)).toBeNull();
  });
});
