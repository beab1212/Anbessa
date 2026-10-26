// The real app on a test database, with local file storage in a temporary directory.
// auth-service is a fake the tests control (organisations, memberships, DRIVER role calls).

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer } from "../../src/container.js";
import type { AuthClient, Membership, Organization } from "../../src/lib/clients.js";
import { AppError } from "../../src/lib/errors.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const ISSUER = "http://localhost:3001";
export const CITY = "addis-ababa";
export const uuid = () => crypto.randomUUID();

/** A tiny valid PNG, different each call (so hashes differ). */
export const png = () => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(uuid())]);

export async function createHarness() {
  const clock = { now: Date.now() };
  const dir = await mkdtemp(join(tmpdir(), "fleet-test-"));
  const orgs = new Map<string, Organization>();
  const members = new Map<string, Membership>();
  const roleCalls: { userId: string; active: boolean }[] = [];
  const authState = { down: false };
  const auth: AuthClient = {
    organization: async (id) => orgs.get(id) ?? null,
    membership: async (orgId, userId) => members.get(`${orgId}:${userId}`) ?? null,
    async setDriverRole(userId, active) {
      if (authState.down) throw new AppError(503, "auth-service is unavailable", "dependency_unavailable");
      roleCalls.push({ userId, active });
    },
  };

  const config = loadConfig({
    NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, INTERNAL_SERVICE_TOKEN: "t".repeat(64),
    PII_ENCRYPTION_KEY: "1".repeat(64), PII_BLIND_INDEX_KEY: "2".repeat(64), UPLOAD_SIGNING_KEY: "3".repeat(64),
    STORAGE: "local", STORAGE_DIR: dir,
  });

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  const token = (sub: string, roles: object[], aud: "ride-app" | "ride-admin") =>
    new SignJWT({ roles, pv: 0, amr: ["otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
      .setSubject(sub).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("15m").sign(privateKey);

  const c = createContainer(config, pino({ level: "silent" }), {
    auth, now: () => new Date(clock.now),
    verifyAccessToken: createTokenVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }) }),
  });
  const app = await buildApp(c);

  type Who = { id: string; token: string };
  const person = async (roles: object[] = [{ r: "RIDER" }], id = uuid()): Promise<Who> => ({ id, token: await token(id, roles, "ride-app") });
  const staff = async (roles: object[], id = uuid()): Promise<Who> => ({ id, token: await token(id, roles, "ride-admin") });
  const officer = (city = CITY) => staff([{ r: "ONBOARDING_OFFICER", city }]);

  function fleetOrg(status: Organization["status"] = "VERIFIED") {
    const id = uuid();
    orgs.set(id, { id, name: "Selam Transport", kind: "FLEET", cityId: CITY, legalName: "Selam Transport PLC", status });
    return id;
  }
  function addMember(orgId: string, userId: string, roles = ["fleet_driver"]) {
    members.set(`${orgId}:${userId}`, { organizationId: orgId, userId, roles, name: "Driver", phoneNumber: "+251911000000", banned: false });
  }

  const req = (method: "GET" | "POST" | "DELETE" | "PUT", url: string, who: Who | null, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers } });

  const ok = async <T = Record<string, unknown>>(p: ReturnType<typeof req>, status = 200): Promise<T> => {
    const r = await p;
    if (r.statusCode !== status) throw new Error(`expected ${status}, got ${r.statusCode}: ${r.body}`);
    return r.json<T>();
  };

  /** The whole upload: ticket → PUT the bytes → confirm. */
  async function upload(who: Who, subjectType: string, subjectId: string, kind: string, opts: { expiresAt?: string; body?: Buffer } = {}) {
    const body = opts.body ?? png();
    const t = await ok<{ uploadUrl: string; ticket: string; headers: Record<string, string> }>(req("POST", "/api/fleet/documents/upload-url", who, {
      subjectType, subjectId, kind, contentType: "image/png", sizeBytes: body.length, sha256: createHash("sha256").update(body).digest("hex"),
    }));
    const put = await app.inject({ method: "PUT", url: t.uploadUrl, payload: body, headers: t.headers });
    if (put.statusCode !== 200) throw new Error(`PUT ${put.statusCode} ${put.body}`);
    return ok<{ id: string; status: string }>(req("POST", "/api/fleet/documents", who, { ticket: t.ticket, ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) }), 201);
  }

  const future = (days = 365) => new Date(clock.now + days * 86_400_000).toISOString().slice(0, 10);
  let licence = 100000;

  /** An applicant with all three driver documents uploaded. */
  async function applicant(roles: object[] = [{ r: "RIDER" }]) {
    const who = await person(roles);
    await ok(req("POST", "/api/fleet/drivers/apply", who, { fullName: "Abebe Kebede", licenseNumber: `AA${licence++}`, cityId: CITY }), 201);
    await upload(who, "DRIVER", who.id, "LICENSE", { expiresAt: future() });
    await upload(who, "DRIVER", who.id, "NATIONAL_ID");
    await upload(who, "DRIVER", who.id, "PHOTO");
    return who;
  }

  /** Officer approves every pending document of a subject. */
  async function approveDocs(by: Who, subjectType: string, subjectId: string) {
    const docs = await ok<{ documents: { document: { id: string; status: string } | null }[] }>(req("GET", `/api/fleet/documents?subjectType=${subjectType}&subjectId=${subjectId}`, by));
    for (const d of docs.documents) {
      if (d.document?.status === "PENDING") await ok(req("POST", `/api/fleet/documents/${d.document.id}/review`, by, { decision: "APPROVE" }));
    }
  }

  /** An ACTIVE driver (application approved). */
  async function activeDriver(roles?: object[]) {
    const who = await applicant(roles);
    await ok(req("POST", "/api/fleet/drivers/me/submit", who));
    const off = await officer();
    await approveDocs(off, "DRIVER", who.id);
    await ok(req("POST", `/api/fleet/drivers/${who.id}/approve`, off));
    return who;
  }

  let plate = 10000;
  const nextPlate = () => `3-A${plate++}`;
  const car = (extra: object = {}) => ({ plateNumber: nextPlate(), vehicleType: "economy", make: "Toyota", model: "Vitz", year: 2018, color: "White", seats: 4, ...extra });

  /** A vehicle with its three documents, submitted and approved. */
  async function verifiedVehicle(owner: Who, body: object) {
    const v = await ok<{ id: string }>(req("POST", "/api/fleet/vehicles", owner, car(body)), 201);
    await upload(owner, "VEHICLE", v.id, "REGISTRATION");
    await upload(owner, "VEHICLE", v.id, "INSURANCE", { expiresAt: future() });
    await upload(owner, "VEHICLE", v.id, "INSPECTION", { expiresAt: future() });
    await ok(req("POST", `/api/fleet/vehicles/${v.id}/submit`, owner));
    const off = await officer();
    await approveDocs(off, "VEHICLE", v.id);
    await ok(req("POST", `/api/fleet/vehicles/${v.id}/approve`, off));
    return v;
  }

  return {
    app, c, clock, orgs, members, roleCalls, authState, person, staff, officer, fleetOrg, addMember, req, ok, upload, future,
    applicant, approveDocs, activeDriver, car, verifiedVehicle,
    outbox: (key: string, topic: string) => c.db.outbox.findMany({ where: { key, topic }, orderBy: { createdAt: "asc" } }).then((rows) => rows.map((r) => r.payload as Record<string, unknown>)),
    close: async () => {
      await app.close();
      await c.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
