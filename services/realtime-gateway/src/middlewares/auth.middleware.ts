import type { Socket } from "socket.io";
import type { Redis } from "ioredis";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { config } from "../config/index.js";

// Auth happens once at handshake, not on every message — re-verifying a JWT on
// every location ping would add latency to a high-frequency hot path.
export function createSocketAuth(redis: Redis) {
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
    } catch {
      next(new Error("unauthorized"));
    }
  };
}
