// verifyAccessToken(): how every service and realtime-gateway checks a Better Auth
// JWT (Auth.md §10). Signature against the JWKS, pinned algorithm, issuer,
// audience, expiry, then optional denylist and permission-version checks.

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { parseRoleClaims, type Principal } from "./principal.js";
import type { Audience } from "./roles.js";

export interface VerifierOptions {
  issuer: string;
  /** e.g. http://auth-service:3001/api/auth/jwks */
  jwksUrl?: string;
  /** Alternative to jwksUrl (tests, local key sets). */
  keySet?: JWTVerifyGetKey;
  algorithms?: string[];
  clockToleranceSeconds?: number;
  /** Returns true if the user is suspended (Redis denylist fed by user.suspended). */
  isDenied?: (userId: string) => Promise<boolean>;
  /** Latest permission version for the user (Redis pv:{userId}); a token with an older pv is rejected. */
  currentPermissionVersion?: (userId: string) => Promise<number | undefined>;
}

export class TokenError extends Error {
  readonly statusCode = 401;
  constructor(readonly code: "invalid_token" | "token_revoked" | "token_outdated", message: string) {
    super(message);
  }
}

/**
 * The suspension / permission-version lookup failed (Redis down). The token is still refused,
 * but as a temporary failure (503), so clients retry instead of treating it as signed out.
 */
export class TokenCheckUnavailable extends Error {
  readonly statusCode = 503;
  readonly code = "auth_unavailable";
  constructor(readonly cause: unknown) {
    super("cannot check the token right now, try again");
  }
}

/** A failure to get the JWKS, as opposed to a token that fails verification. */
function keySetUnreachable(err: unknown): boolean {
  if (!(err instanceof errors.JOSEError)) return true; // fetch threw (connection refused, DNS…)
  if (err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid) return true;
  return /JSON Web Key Set HTTP response/.test(err.message); // a non-200 from the JWKS endpoint
}

export function createTokenVerifier(options: VerifierOptions) {
  const keySet = options.keySet ?? (options.jwksUrl ? createRemoteJWKSet(new URL(options.jwksUrl)) : undefined);
  if (!keySet) throw new Error("createTokenVerifier needs jwksUrl or keySet");
  const algorithms = options.algorithms ?? ["ES256"];

  return async function verifyAccessToken(token: string, audience: Audience): Promise<Principal> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: options.issuer,
        audience,
        algorithms,
        clockTolerance: options.clockToleranceSeconds ?? 30,
        requiredClaims: ["sub", "exp", "iat"],
      }));
    } catch (err) {
      // The key set couldn't be fetched (auth-service down or slow): that says nothing about the
      // token, so it's a temporary failure, not a reason to sign the person out.
      if (keySetUnreachable(err)) throw new TokenCheckUnavailable(err);
      throw new TokenError("invalid_token", "invalid or expired access token");
    }

    const userId = payload.sub!;
    const lookup = async <T>(f: () => Promise<T>): Promise<T> => {
      try {
        return await f();
      } catch (err) {
        throw new TokenCheckUnavailable(err);
      }
    };
    if (options.isDenied && (await lookup(() => options.isDenied!(userId)))) {
      throw new TokenError("token_revoked", "account suspended");
    }
    const pv = typeof payload.pv === "number" ? payload.pv : 0;
    if (options.currentPermissionVersion) {
      const current = await lookup(() => options.currentPermissionVersion!(userId));
      if (current !== undefined && pv < current) throw new TokenError("token_outdated", "roles changed, refresh the token");
    }

    return {
      userId,
      audience,
      roles: parseRoleClaims(payload.roles, audience),
      permissionVersion: pv,
      amr: Array.isArray(payload.amr) ? payload.amr.filter((m: unknown): m is string => typeof m === "string") : [],
      actor: typeof payload.act === "object" && payload.act && typeof (payload.act as { sub?: unknown }).sub === "string"
        ? (payload.act as { sub: string }).sub
        : undefined,
    };
  };
}

export type VerifyAccessToken = ReturnType<typeof createTokenVerifier>;

/** Extract a bearer token from an Authorization header value. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : undefined;
}
