import type { Socket } from "socket.io";
import type { Redis } from "ioredis";
import { createTokenVerifier, TokenError } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import { config } from "../config/index.js";

// Auth happens once at handshake, not on every message — re-verifying a JWT on
// every location ping would add latency to a high-frequency hot path.
export function createSocketAuth(redis: Redis, logger: Logger) {
  const verify = createTokenVerifier({
    issuer: config.AUTH_ISSUER,
    jwksUrl: config.AUTH_JWKS_URL,
    // suspension and role changes written by auth-service (Auth.md §9.5)
    isDenied: async (userId) => (await redis.exists(`deny:${userId}`)) === 1,
    currentPermissionVersion: async (userId) => {
      const pv = await redis.get(`pv:${userId}`);
      return pv === null ? undefined : Number(pv);
    },
  });

  return async function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void) {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || !token) throw new Error("missing token");
      const principal = await verify(token, "ride-app");
      socket.data.userId = principal.userId;
      socket.data.principal = principal;
      next();
    } catch (err) {
      // "unauthorized: <reason>" means the token itself was refused (the app refreshes it, and
      // signs out after repeated refusals). Anything else (Redis or the JWKS down) is
      // "unavailable": the app just retries.
      if (err instanceof TokenError) return next(new Error(`unauthorized: ${err.code}`));
      if (err instanceof Error && err.message === "missing token") return next(new Error("unauthorized: missing_token"));
      logger.warn({ err }, "socket auth: token check unavailable");
      next(new Error("unavailable"));
    }
  };
}
