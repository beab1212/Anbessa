// auth-service keeps a copy of every city (and its staff organisation) for staff scopes.

import { AppError } from "./errors.js";
import type { IdentitySync } from "../catalog/service.js";

export function identitySync(authInternalUrl: string, token: string): IdentitySync {
  return {
    async upsertCity(city) {
      let res: Response;
      try {
        res = await fetch(new URL(`/internal/cities/${city.id}`, authInternalUrl), {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-service-name": "platform-service" },
          body: JSON.stringify({ name: city.name, timezone: city.timezone }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        throw new AppError(503, "auth-service is unavailable; try again", "dependency_unavailable");
      }
      if (!res.ok) throw new AppError(503, `auth-service answered ${res.status}`, "dependency_unavailable");
    },
  };
}
