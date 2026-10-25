import type { Redis } from "ioredis";
import type { BetterAuthOptions } from "better-auth";

type SecondaryStorage = NonNullable<BetterAuthOptions["secondaryStorage"]>;

// INCR, and set the TTL only when the key is new (fixed window, as Better Auth expects)
const INCREMENT = `local v = redis.call('INCR', KEYS[1]); if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return v`;

/** Better Auth secondary storage (sessions, rate-limit counters) on Redis, namespaced. */
export function redisSecondaryStorage(redis: Redis, prefix = "ba:"): SecondaryStorage {
  return {
    get: (key) => redis.get(prefix + key),
    getAndDelete: (key) => redis.getdel(prefix + key),
    increment: async (key, ttl) => Number(await redis.eval(INCREMENT, 1, prefix + key, Math.max(1, Math.ceil(ttl)))),
    set: async (key, value, ttl) => {
      if (ttl) await redis.set(prefix + key, value, "EX", ttl);
      else await redis.set(prefix + key, value);
    },
    delete: async (key) => {
      await redis.del(prefix + key);
    },
  };
}
