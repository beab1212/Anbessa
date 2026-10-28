// The real app on a test database, with the in-process provider simulator. Its callbacks are
// injected into the app's webhook route (signature checks included). Kafka is replaced by calling
// the event handlers; the clock is the test's.

import pino from "pino";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { staticSettings } from "@ride-app/shared-settings";
import type { TripCancelledEvent, TripCompletedEvent } from "@ride-app/shared-types";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer } from "../../src/container.js";
import { simStore } from "../../src/gateways/simulator.js";
import type { TripFacts, TripLookup } from "../../src/lib/trips.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const ISSUER = "http://localhost:3001";
export const CITY = "addis-ababa";
export const uuid = () => crypto.randomUUID();

/**
 * `env` overrides the test config; `trips` is trip-service's record of trips (the trip event check
 * is on when given: a Map of trip id → facts, or a lookup that throws to play trip-service down).
 */
export async function createHarness(opts: { env?: Record<string, string>; trips?: Map<string, TripFacts> | TripLookup } = {}) {
  const clock = { now: Date.now() };
  const pushes: { userId: string; event: string; payload: unknown }[] = [];
  const callbacks = { drop: false, delivered: 0 };

  const config = loadConfig({
    NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, INTERNAL_SERVICE_TOKEN: "t".repeat(64), PUBLIC_URL: "http://pay.test",
    TELEBIRR_WEBHOOK_SECRET: "a".repeat(48), CBEBIRR_WEBHOOK_SECRET: "b".repeat(48), CHAPA_WEBHOOK_SECRET: "c".repeat(48),
    SIM_AUTO_APPROVE_SECONDS: "0", SIM_PAYOUT_SECONDS: "0", PAYMENT_RETRY_SECONDS: "60,600", ...opts.env,
  });
  const trips: TripLookup | undefined = opts.trips instanceof Map ? { get: async (id) => (opts.trips as Map<string, TripFacts>).get(id) ?? null } : opts.trips;

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  const token = (sub: string, roles: object[], aud: "ride-app" | "ride-admin") =>
    new SignJWT({ roles, pv: 0, amr: ["otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
      .setSubject(sub).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("15m").sign(privateKey);

  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const settings = staticSettings();
  const c = createContainer(config, pino({ level: "silent" }), {
    now: () => new Date(clock.now), settings, simStore: simStore(), ...(trips ? { trips } : {}),
    realtime: { toUser: (userId, event, payload) => void pushes.push({ userId, event, payload }) },
    verifyAccessToken: createTokenVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }) }),
    // the provider calls our webhook (a dropped callback is what reconciliation recovers)
    deliver: async (url, body, headers) => {
      if (callbacks.drop) return 200;
      callbacks.delivered++;
      const r = await app!.inject({ method: "POST", url: new URL(url).pathname, payload: body, headers: { "content-type": "application/json", ...headers } });
      return r.statusCode;
    },
  });
  app = await buildApp(c);

  type Who = { id: string; token: string };
  const person = async (roles: object[] = [{ r: "RIDER" }], id = uuid()): Promise<Who> => ({ id, token: await token(id, roles, "ride-app") });
  const staff = async (roles: object[], id = uuid()): Promise<Who> => ({ id, token: await token(id, roles, "ride-admin") });
  const driver = () => person([{ r: "DRIVER" }, { r: "RIDER" }]);
  const financeOfficer = () => staff([{ r: "FINANCE_OFFICER" }]);
  const financeManager = () => staff([{ r: "FINANCE_MANAGER" }]);

  const req = (method: "GET" | "POST" | "PUT", url: string, who: Who | null, payload?: object, headers: Record<string, string> = {}) =>
    app!.inject({ method, url, payload, headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers } });

  const ok = async <T = Record<string, unknown>>(p: ReturnType<typeof req>, status = 200): Promise<T> => {
    const r = await p;
    if (r.statusCode !== status) throw new Error(`expected ${status}, got ${r.statusCode}: ${r.body}`);
    return r.json<T>();
  };

  const at = () => new Date(clock.now).toISOString();
  const envelope = () => ({ eventId: uuid(), version: 1, at: at() });

  /** trip-service's trip.completed for a trip by `driverId` (or a fleet's car). */
  function completed(input: { driverId: string; fareMinor: number; paymentMethod?: TripCompletedEvent["paymentMethod"]; fleetOrgId?: string; riderId?: string; cityId?: string; billingOrgId?: string }): TripCompletedEvent {
    return {
      ...envelope(), tripId: uuid(), riderId: input.riderId ?? uuid(), driverId: input.driverId, cityId: input.cityId ?? CITY, vehicleType: "economy", vehicleId: uuid(),
      beneficiary: input.fleetOrgId ? { type: "ORGANIZATION", id: input.fleetOrgId } : { type: "INDIVIDUAL", id: input.driverId },
      paymentMethod: input.paymentMethod ?? "CASH", billingType: input.billingOrgId ? "CORPORATE" : "PERSONAL", ...(input.billingOrgId ? { billingOrgId: input.billingOrgId } : {}),
      fareMinor: input.fareMinor, waitingFeeMinor: 0, currency: "ETB", distanceMeters: 5000, durationSeconds: 900, completedAt: at(),
    };
  }

  /** trip-service's record of the trip an event is about (what /internal/trips/:id answers). */
  function factsOf(e: TripCompletedEvent | TripCancelledEvent): TripFacts {
    const done = "fareMinor" in e;
    return {
      id: e.tripId, status: done ? "completed" : "cancelled", cityId: e.cityId, riderUserId: e.riderId, paymentMethod: e.paymentMethod,
      billing: { type: e.billingOrgId ? "CORPORATE" : "PERSONAL", orgId: e.billingOrgId ?? null },
      driver: e.driverId ? { userId: e.driverId } : null, beneficiary: e.beneficiary ?? null,
      fare: done
        ? { finalMinor: e.fareMinor, waitingFeeMinor: e.waitingFeeMinor, promoDiscountMinor: e.promoDiscountMinor ?? 0, currency: e.currency }
        : { finalMinor: null, waitingFeeMinor: null, promoDiscountMinor: 0, currency: e.currency },
      cancellation: done ? null : { feeMinor: e.feeMinor, driverCompensationMinor: e.driverCompensationMinor },
    };
  }

  function cancelled(input: { driverId: string; feeMinor: number; compensationMinor: number; paymentMethod?: TripCancelledEvent["paymentMethod"]; riderId?: string }): TripCancelledEvent {
    return {
      ...envelope(), tripId: uuid(), riderId: input.riderId ?? uuid(), driverId: input.driverId, cityId: CITY, by: "RIDER", reason: "CHANGED_PLANS",
      paymentMethod: input.paymentMethod ?? "CASH", feeMinor: input.feeMinor, driverCompensationMinor: input.compensationMinor,
      beneficiary: { type: "INDIVIDUAL", id: input.driverId }, currency: "ETB",
    };
  }

  const balanceOf = async (type: "INDIVIDUAL" | "ORGANIZATION", ownerId: string) => {
    const b = await c.db.beneficiary.findUnique({ where: { type_ownerId: { type, ownerId } }, include: { account: true } });
    return b ? { accountId: b.accountId, balance: Number(b.account.balanceMinor), state: b.state, referenceCode: b.referenceCode } : null;
  };
  const accountBalance = async (code: string) => Number((await c.db.ledgerAccount.findUnique({ where: { code } }))?.balanceMinor ?? 0n);
  const outbox = (topic: string) => c.db.outbox.findMany({ where: { topic }, orderBy: { createdAt: "asc" } });
  /** Wait for asynchronous provider callbacks (up to 3 s). */
  const until = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 150 && !(await done()); i++) await new Promise((r) => setTimeout(r, 20));
  };

  return {
    app, c, clock, settings, pushes, callbacks, person, staff, driver, financeOfficer, financeManager, req, ok,
    completed, cancelled, factsOf, balanceOf, accountBalance, outbox, until,
    async close() {
      await app!.close();
      await c.close();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
