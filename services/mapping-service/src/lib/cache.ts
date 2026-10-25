import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** Cache-aside in Redis. Failures never fail the request: a cache miss is the worst case. */
export function redisCache(redis: Redis, prefix = "map:"): Cache {
  return {
    async get<T>(key: string) {
      try {
        const v = await redis.get(prefix + key);
        return v ? (JSON.parse(v) as T) : undefined;
      } catch {
        return undefined;
      }
    },
    async set(key, value, ttlSeconds) {
      await redis.set(prefix + key, JSON.stringify(value), "EX", ttlSeconds).catch(() => undefined);
    },
  };
}

export const noCache: Cache = { get: async () => undefined, set: async () => undefined };

/** Short, stable cache key (queries can be long; hashing keeps keys bounded and opaque). */
export const cacheKey = (kind: string, parts: unknown) =>
  `${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 32)}`;
