import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { breaker } from "./engines/http.js";
import { nominatimClient, type NominatimClient } from "./engines/nominatim.js";
import { osrmClient, type OsrmClient } from "./engines/osrm.js";
import { noCache, redisCache, type Cache } from "./lib/cache.js";
import { createMaps } from "./maps.js";
import { COUNTRY_CODES } from "./regions.js";

export interface ContainerOptions {
  osrm?: OsrmClient;
  nominatim?: NominatimClient;
  cache?: Cache;
  verifyAccessToken?: VerifyAccessToken;
}

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const redis = !opts.cache && config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 }) : undefined;
  const osrmBreaker = breaker("osrm");
  const nominatimBreaker = breaker("nominatim");
  const maps = createMaps({
    osrm: opts.osrm ?? osrmClient(config.OSRM_URL, config.ENGINE_TIMEOUT_MS),
    nominatim: opts.nominatim ?? nominatimClient(config.NOMINATIM_URL, config.ENGINE_TIMEOUT_MS, COUNTRY_CODES),
    osrmBreaker,
    nominatimBreaker,
    cache: opts.cache ?? (redis ? redisCache(redis) : noCache),
    logger,
  });
  return {
    maps,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    verifyAccessToken: opts.verifyAccessToken ?? createTokenVerifier({ issuer: config.AUTH_ISSUER, jwksUrl: config.AUTH_JWKS_URL }),
    engineStatus: () => ({
      osrm: osrmBreaker.open ? ("degraded" as const) : ("ok" as const),
      nominatim: nominatimBreaker.open ? ("degraded" as const) : ("ok" as const),
    }),
    close: async () => void redis?.disconnect(),
  };
}
