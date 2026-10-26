// One origin, two sign-ins. Staff use the admin surface (/api/admin-auth, password + TOTP),
// partners the app surface (/api/auth, phone code). Each keeps its own session cookie; the
// short-lived access token (10 or 15 min) is fetched from /token and kept in memory only.

import { can, parseRoleClaims, type Audience, type Permission, type Principal, type ResourceScope } from "@ride-app/shared-authz";

export type Surface = "staff" | "partner";

const AUTH: Record<Surface, string> = { staff: "/api/admin-auth", partner: "/api/auth" };
const AUDIENCE: Record<Surface, Audience> = { staff: "ride-admin", partner: "ride-app" };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; code?: string; message?: string };
    throw new ApiError(res.status, b.error ?? b.code ?? "error", b.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

/** Better Auth endpoints: cookie session, same origin. */
export async function authCall<T = unknown>(surface: Surface, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${AUTH[surface]}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(res);
}

// ── access tokens ───────────────────────────────────────────────────────────

export interface Claims {
  sub: string;
  exp: number;
  pv: number;
  amr: string[];
  roles: unknown;
  setup?: { twoFactor: boolean; changePassword: boolean };
}

const cache: Partial<Record<Surface, { token: string; claims: Claims }>> = {};

export function decodeClaims(token: string): Claims {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Claims;
}

/** The current access token, refreshed a minute before it expires. null = not signed in. */
export async function accessToken(surface: Surface, force = false): Promise<{ token: string; claims: Claims } | null> {
  const hit = cache[surface];
  if (!force && hit && hit.claims.exp * 1000 - Date.now() > 60_000) return hit;
  const res = await fetch(`${AUTH[surface]}/token`, { credentials: "include" });
  if (res.status === 401 || res.status === 403) {
    delete cache[surface];
    return null;
  }
  const { token } = await parse<{ token: string }>(res);
  const entry = { token, claims: decodeClaims(token) };
  cache[surface] = entry;
  return entry;
}

export function forgetTokens(surface: Surface) {
  delete cache[surface];
}

/** A service call with the surface's bearer token. Retries once with a fresh token on 401. */
export async function api<T = unknown>(
  surface: Surface,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await accessToken(surface, attempt > 0);
    if (!t) throw new ApiError(401, "signed_out", "Your session ended. Sign in again.");
    const res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${t.token}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 401 && attempt === 0) continue; // role changed (pv) or token expired: refresh once
    return parse<T>(res);
  }
  throw new ApiError(401, "signed_out", "Your session ended. Sign in again.");
}

// ── who is this ─────────────────────────────────────────────────────────────

export function principalOf(surface: Surface, claims: Claims): Principal {
  return {
    userId: claims.sub,
    audience: AUDIENCE[surface],
    roles: parseRoleClaims(claims.roles, AUDIENCE[surface]),
    permissionVersion: claims.pv,
    amr: claims.amr,
  };
}

/** For showing and hiding UI only. Every service checks the same matrix again on each request. */
export const allowed = (p: Principal | null, permission: Permission, scope?: ResourceScope) => !!p && can(p, permission, scope);

/** Cities where the principal holds `permission` (staff are city-scoped; GLOBAL roles see all). */
export function citiesFor(p: Principal | null, permission: Permission, all: string[]): string[] {
  if (!p) return [];
  return all.filter((cityId) => can(p, permission, { cityId }));
}

export const newIdempotencyKey = () => `web-${crypto.randomUUID()}`;
