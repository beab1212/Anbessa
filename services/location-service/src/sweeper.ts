// Staleness sweeper (workflow 04, steps 13–14), every 5 s. Each city is swept by one
// replica at a time: a short Redis lock (SET NX PX) decides who.

import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { keys, sweepCity } from "@ride-app/shared-location";
import type { Logger } from "@ride-app/shared-utils";

export function createSweeper(deps: {
  redis: Redis;
  logger: Logger;
  intervalMs: number;
  onLost?: (driverId: string, cityId: string, lastSeenAt: Date) => Promise<void>;
  now?: () => number;
}) {
  const { redis, logger } = deps;
  const now = deps.now ?? Date.now;
  const owner = randomUUID();
  let timer: NodeJS.Timeout | undefined;

  async function sweepOnce() {
    const cities = await redis.smembers(keys.cities());
    let stale = 0;
    let lost = 0;
    for (const cityId of cities) {
      const lock = keys.sweepLock(cityId);
      if ((await redis.set(lock, owner, "PX", Math.max(1000, deps.intervalMs - 500), "NX")) !== "OK") continue;
      const r = await sweepCity(redis, cityId, now());
      stale += r.stale.length;
      lost += r.lost.length;
      for (const { driverId, lastSeen } of r.lost) {
        await deps.onLost?.(driverId, cityId, new Date(lastSeen)).catch((err) =>
          logger.error({ driverId, err: (err as Error).message }, "could not report lost driver"),
        );
      }
    }
    return { stale, lost };
  }

  return {
    sweepOnce,
    start() {
      timer = setInterval(() => void sweepOnce().catch((err) => logger.error({ err: (err as Error).message }, "sweep failed")), deps.intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
