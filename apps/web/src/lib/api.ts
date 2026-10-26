// One origin, two sign-ins. Staff use the admin surface (/api/admin-auth, password + TOTP),
// partners the app surface (/api/auth, phone code). Each keeps its own session cookie; the
// short-lived access token (10 or 15 min) is fetched from /token and kept in memory only.

import axios, { AxiosError } from "axios";
import { can, parseRoleClaims, type Audience, type Permission, type Principal, type ResourceScope } from "@ride-app/shared-authz";

export type Surface = "staff" | "partner";

const AUTH: Record<Surface, string> = { staff: "/api/admin-auth", partner: "/api/auth" };
const AUDIENCE: Record<Surface, Audience> = { staff: "ride-admin", partner: "ride-app" };

declare module "axios" {
  interface AxiosRequestConfig {
    /** Send the surface's bearer token (service calls). */
    surface?: Surface;
    /** Internal: this is the one retry after a 401. */
    retried?: boolean;
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Every failure leaves this module as an ApiError: status, a code, and a message a person can read. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof AxiosError && err.response) {
    const b = (err.response.data ?? {}) as { error?: string; code?: string; message?: string };
    return new ApiError(err.response.status, b.error ?? b.code ?? "error", b.message ?? `Request failed (${err.response.status})`);
  }
  return new ApiError(0, "network", "Can't reach the server. Check your connection and try again.");
}

const dataOf = <T>(res: { status: number; data: unknown }) => (res.status === 204 ? undefined : res.data) as T;

// Better Auth endpoints: cookie session, same origin.
export const authHttp = axios.create({ withCredentials: true });
authHttp.interceptors.response.use(undefined, (err) => Promise.reject(toApiError(err)));

/** Better Auth call on a surface (GET without a body, POST with one). */
export async function authCall<T = unknown>(surface: Surface, path: string, body?: unknown): Promise<T> {
  const url = `${AUTH[surface]}${path}`;
  return dataOf<T>(body === undefined ? await authHttp.get(url) : await authHttp.post(url, body));
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
  try {
    const { token } = await authCall<{ token: string }>(surface, "/token");
    const entry = { token, claims: decodeClaims(token) };
    cache[surface] = entry;
    return entry;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      delete cache[surface];
      return null;
    }
    throw err;
  }
}

export function forgetTokens(surface: Surface) {
  delete cache[surface];
}

// ── service calls ───────────────────────────────────────────────────────────

const signedOut = () => new ApiError(401, "signed_out", "Your session ended. Sign in again.");

/** Same-origin /api/* client. With `surface` set it sends that surface's bearer token. */
export const http = axios.create();

http.interceptors.request.use(async (config) => {
  if (!config.surface) return config;
  const t = await accessToken(config.surface, config.retried);
  if (!t) throw signedOut();
  config.headers.set("Authorization", `Bearer ${t.token}`);
  return config;
});

http.interceptors.response.use(undefined, async (err) => {
  const config = err instanceof AxiosError ? err.config : undefined;
  if (config?.surface && err.response?.status === 401) {
    if (config.retried) throw signedOut();
    return http.request({ ...config, retried: true }); // role changed (pv) or token expired: refresh once
  }
  throw toApiError(err);
});

/** A service call with the surface's bearer token. Retries once with a fresh token on 401. */
export async function api<T = unknown>(
  surface: Surface,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const res = await http.request({
    url: path,
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    data: init.body,
    surface,
    headers: init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : undefined,
  });
  return dataOf<T>(res);
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
