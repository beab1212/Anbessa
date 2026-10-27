// auth-service internal API (never routed by Kong; shared service token until mTLS, Auth.md §15).

import { AppError } from "./errors.js";

export interface Organization {
  id: string;
  name: string;
  kind: "FLEET" | "CORPORATE" | "STAFF_CITY" | "STAFF_HQ";
  cityId: string;
  legalName: string | null;
  status: "PENDING" | "VERIFIED" | "SUSPENDED";
}

export interface Membership {
  organizationId: string;
  userId: string;
  /** stored Better Auth role names, e.g. ["fleet_driver"] */
  roles: string[];
  name: string;
  phoneNumber: string | null;
  banned: boolean;
}

export interface AuthClient {
  organization(id: string): Promise<Organization | null>;
  membership(orgId: string, userId: string): Promise<Membership | null>;
  /** Grant or remove the DRIVER role (idempotent). */
  setDriverRole(userId: string, active: boolean): Promise<void>;
}

export function authClient(baseUrl: string, token: string): AuthClient {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(new URL(path, baseUrl), {
        method,
        headers: { authorization: `Bearer ${token}`, "x-service-name": "fleet-service", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new AppError(503, "auth-service is unavailable", "dependency_unavailable");
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError(503, `auth-service answered ${res.status}`, "dependency_unavailable");
    return (await res.json()) as T;
  }
  return {
    organization: (id) => call<Organization>("GET", `/internal/organizations/${id}`),
    membership: (orgId, userId) => call<Membership>("GET", `/internal/organizations/${orgId}/members/${userId}`),
    async setDriverRole(userId, active) {
      // a 404 means auth-service has no such user: the change must not go through silently
      const r = await call("POST", `/internal/drivers/${userId}/role`, { active });
      if (r === null) throw new AppError(409, "auth-service has no account for this driver", "user_not_found");
    },
  };
}

// payment-service internal API: the authoritative balance state when a driver goes online
// (Payment.md §14). A failure answers null: the session starts, and location-service still applies
// the latest published state from Redis.

export interface BalanceState {
  state: "OK" | "WARNING" | "CASH_BLOCKED" | "BLOCKED";
  cashAllowed: boolean;
}

export interface BalanceClient {
  state(type: "INDIVIDUAL" | "ORGANIZATION", ownerId: string): Promise<BalanceState | null>;
}

export function balanceClient(baseUrl: string, token: string): BalanceClient {
  return {
    async state(type, ownerId) {
      try {
        const res = await fetch(new URL(`/internal/balances/state?type=${type}&ownerId=${ownerId}`, baseUrl), {
          headers: { authorization: `Bearer ${token}`, "x-service-name": "fleet-service" },
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return null;
        return (await res.json()) as BalanceState;
      } catch {
        return null;
      }
    },
  };
}
