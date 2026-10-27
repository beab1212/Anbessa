// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { noRealtime, socketEmitter, type Realtime } from "./lib/realtime.js";
import { tripLookup, type TripLookup } from "./lib/trips.js";
import { createIncidentService } from "./support/incidents.js";
import { createLostItemService } from "./support/lost-items.js";
import { createSosService } from "./support/sos.js";
import { createTicketService } from "./support/tickets.js";

export interface ContainerOptions {
  db?: Db;
  trips?: TripLookup;
  realtime?: Realtime;
  verifyAccessToken?: VerifyAccessToken;
  now?: () => Date;
}

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 }) : undefined;
  const now = opts.now ?? (() => new Date());
  const deps = {
    db, logger, now,
    trips: opts.trips ?? tripLookup(config.TRIP_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
    realtime: opts.realtime ?? (redis ? socketEmitter(redis) : noRealtime),
  };

  // tokens of suspended users, and tokens older than a role change, are refused (Auth.md §9.5)
  const verifyAccessToken =
    opts.verifyAccessToken ??
    createTokenVerifier({
      issuer: config.AUTH_ISSUER,
      jwksUrl: config.AUTH_JWKS_URL,
      ...(redis
        ? {
            isDenied: async (userId: string) => (await redis.exists(`deny:${userId}`)) === 1,
            currentPermissionVersion: async (userId: string) => {
              const v = await redis.get(`pv:${userId}`);
              return v === null ? undefined : Number(v);
            },
          }
        : {}),
    });

  return {
    config, db, redis, now, verifyAccessToken,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    tickets: createTicketService(deps),
    lostItems: createLostItemService(deps),
    sos: createSosService(deps),
    incidents: createIncidentService(deps),
    async close() {
      await db.$disconnect();
      redis?.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
