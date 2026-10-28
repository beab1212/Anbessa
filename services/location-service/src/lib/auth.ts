// The access-token verifier, with the same Redis checks as every other service (Auth.md §9.5):
// tokens of suspended users (deny:{userId}) and tokens older than a role change (pv:{userId})
// are refused.

import type { Redis } from "ioredis";
import { createTokenVerifier, type VerifierOptions, type VerifyAccessToken } from "@ride-app/shared-authz";

/** isDenied + currentPermissionVersion, read from the shared Redis. */
export function revocationChecks(redis: Pick<Redis, "exists" | "get">): Pick<VerifierOptions, "isDenied" | "currentPermissionVersion"> {
  return {
    isDenied: async (userId) => (await redis.exists(`deny:${userId}`)) === 1,
    currentPermissionVersion: async (userId) => {
      const v = await redis.get(`pv:${userId}`);
      return v === null ? undefined : Number(v);
    },
  };
}

export function createVerifier(opts: Omit<VerifierOptions, "isDenied" | "currentPermissionVersion">, redis: Pick<Redis, "exists" | "get">): VerifyAccessToken {
  return createTokenVerifier({ ...opts, ...revocationChecks(redis) });
}
