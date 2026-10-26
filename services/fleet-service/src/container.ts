// Composition root: builds every dependency from config. Used by the server and the tests.

import { createHmac } from "node:crypto";
import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { authClient, type AuthClient } from "./lib/clients.js";
import { piiCrypto, signer } from "./lib/crypto.js";
import { localStore, s3Store, type ObjectStore } from "./lib/storage.js";
import { createFleetService } from "./fleet/service.js";

export interface ContainerOptions {
  db?: Db;
  auth?: AuthClient;
  store?: ObjectStore;
  verifyAccessToken?: VerifyAccessToken;
  now?: () => Date;
}

/** Separate keys for upload tickets and file links, derived from UPLOAD_SIGNING_KEY. */
const subKey = (hex: string, label: string) => createHmac("sha256", Buffer.from(hex, "hex")).update(label).digest("hex");

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 }) : undefined;
  const now = opts.now ?? (() => new Date());
  const clock = () => now().getTime();
  const tickets = signer(subKey(config.UPLOAD_SIGNING_KEY, "upload-ticket"), clock);
  const fileTickets = signer(subKey(config.UPLOAD_SIGNING_KEY, "file-link"), clock);
  const store =
    opts.store ??
    (config.STORAGE === "s3"
      ? s3Store({ bucket: config.S3_BUCKET!, region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE })
      : localStore(config.STORAGE_DIR, fileTickets));
  const auth = opts.auth ?? authClient(config.AUTH_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);

  const fleet = createFleetService({
    db, store, tickets, auth, logger, now,
    pii: piiCrypto(config.PII_ENCRYPTION_KEY, config.PII_BLIND_INDEX_KEY),
    expiryWarningDays: config.EXPIRY_WARNING_DAYS,
  });

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
    config, db, fleet, store, fileTickets, verifyAccessToken,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    async close() {
      await db.$disconnect();
      redis?.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
