// Fast security signals for verifiers (Auth.md §9.5, Role.md §10), written after commit:
//   deny:{userId}  → present while suspended (services refuse unexpired JWTs)
//   pv:{userId}    → latest permission version (services refuse older tokens)
// Kafka events (user.suspended, role.*) remain the durable source; these keys
// are a fast path, so failures are logged, not fatal.

import type { Redis } from "ioredis";
import type { Logger } from "@ride-app/shared-utils";

const DENY_TTL_SECONDS = 60 * 30; // > the longest JWT lifetime (15 min); refreshed while banned

export interface SecuritySignals {
  deny(userId: string, until?: Date | null): Promise<void>;
  allow(userId: string): Promise<void>;
  permissionVersion(userId: string, version: number): Promise<void>;
  isDenied(userId: string): Promise<boolean>;
  currentPermissionVersion(userId: string): Promise<number | undefined>;
}

export function redisSignals(redis: Redis, logger: Logger): SecuritySignals {
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "security signal unavailable");
      return fallback;
    }
  };
  return {
    deny: (userId, until) =>
      safe(async () => {
        const ttl = until ? Math.max(60, Math.ceil((until.getTime() - Date.now()) / 1000)) : DENY_TTL_SECONDS;
        await redis.set(`deny:${userId}`, "1", "EX", Math.min(ttl, DENY_TTL_SECONDS));
      }, undefined),
    allow: (userId) => safe(async () => void (await redis.del(`deny:${userId}`)), undefined),
    permissionVersion: (userId, version) =>
      safe(async () => void (await redis.set(`pv:${userId}`, String(version), "EX", 60 * 60 * 24)), undefined),
    isDenied: (userId) => safe(async () => (await redis.exists(`deny:${userId}`)) === 1, false),
    currentPermissionVersion: (userId) =>
      safe(async () => {
        const v = await redis.get(`pv:${userId}`);
        return v === null ? undefined : Number(v);
      }, undefined),
  };
}

/** Without Redis (local dev): suspension still revokes sessions; tokens expire within 15 min. */
export function noopSignals(): SecuritySignals {
  return {
    deny: async () => undefined,
    allow: async () => undefined,
    permissionVersion: async () => undefined,
    isDenied: async () => false,
    currentPermissionVersion: async () => undefined,
  };
}
