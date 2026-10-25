import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
import type { FastifyRequest } from "fastify";
import { bearerToken, createTokenVerifier, type Audience, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { SecuritySignals } from "../lib/signals.js";
import { unauthorized } from "../lib/errors.js";

/**
 * Key set backed by Better Auth's own JWKS (no HTTP round trip to ourselves).
 * Cached for 5 minutes and reloaded at once when a token carries an unknown kid (rotation).
 */
export function betterAuthKeySet(load: () => Promise<JSONWebKeySet>): JWTVerifyGetKey {
  let keySet: JWTVerifyGetKey | undefined;
  let loadedAt = 0;
  const refresh = async () => {
    keySet = createLocalJWKSet(await load());
    loadedAt = Date.now();
    return keySet;
  };
  return async (header, token) => {
    const ks = !keySet || Date.now() - loadedAt > 5 * 60_000 ? await refresh() : keySet;
    try {
      return await ks(header, token);
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY") return (await refresh())(header, token);
      throw err;
    }
  };
}

export function createPrincipalResolver(opts: { issuer: string; keySet: JWTVerifyGetKey; signals: SecuritySignals }) {
  const verify: VerifyAccessToken = createTokenVerifier({
    issuer: opts.issuer,
    keySet: opts.keySet,
    isDenied: (id) => opts.signals.isDenied(id),
    currentPermissionVersion: (id) => opts.signals.currentPermissionVersion(id),
  });
  return async function requirePrincipal(req: FastifyRequest, audience: Audience): Promise<Principal> {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    return verify(token, audience);
  };
}

export type RequirePrincipal = ReturnType<typeof createPrincipalResolver>;
