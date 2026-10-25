// Builds JWT claims for Better Auth's jwt plugin (`definePayload`, Auth.md §8).
// Minimal: no PII. Roles are filtered by surface, and staff roles require 2FA.

import { APIError } from "better-auth/api";
import { ROLES, toRoleClaim, type RoleAssignment } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { toAssignments } from "./roles-codec.js";

export type Surface = "app" | "admin";

interface ClaimsUser {
  id: string;
  role?: string | null;
  permissionVersion?: number | null;
  twoFactorEnabled?: boolean | null;
  mustChangePassword?: boolean | null;
  banned?: boolean | null;
}

interface ClaimsSession {
  surface?: string | null;
}

export function selectRolesForSurface(
  assignments: RoleAssignment[],
  surface: Surface,
  user: ClaimsUser,
): RoleAssignment[] {
  const audience = surface === "app" ? "ride-app" : "ride-admin";
  const forAudience = assignments.filter((a) => ROLES[a.role].audience === audience);
  if (surface === "admin") {
    // Staff roles only with two-factor enabled and a changed initial password.
    if (!user.twoFactorEnabled || user.mustChangePassword) return [];
  }
  return forAudience;
}

export function createClaimsBuilder(db: Db, surface: Surface) {
  return async function definePayload({ user: sessionUser, session }: { user: ClaimsUser; session: ClaimsSession }) {
    // A session belongs to exactly one surface: an app session can never mint admin tokens.
    if ((session.surface ?? "app") !== surface) {
      throw new APIError("FORBIDDEN", { message: "session does not belong to this surface" });
    }
    // Read the user fresh. With secondary storage (Redis) Better Auth hands us the copy cached
    // with the session, which still has the roles and permission version from sign-in: a granted
    // role would never reach the token, and its stale `pv` would be refused by every verifier.
    const user = await db.user.findUnique({
      where: { id: sessionUser.id },
      select: { id: true, role: true, permissionVersion: true, twoFactorEnabled: true, mustChangePassword: true, banned: true },
    });
    if (!user) throw new APIError("UNAUTHORIZED", { message: "account not found" });
    if (user.banned) throw new APIError("FORBIDDEN", { message: "account suspended" });

    const memberships = await db.member.findMany({
      where: { userId: user.id },
      select: { role: true, validUntil: true, organization: { select: { id: true, kind: true, cityId: true, status: true } } },
    });
    const roles = selectRolesForSurface(toAssignments(user.role, memberships), surface, user);

    const claims: Record<string, unknown> = {
      roles: roles.map(toRoleClaim),
      pv: user.permissionVersion ?? 0,
      amr: surface === "admin" ? (user.twoFactorEnabled ? ["pwd", "otp"] : ["pwd"]) : ["otp"],
    };
    if (surface === "admin" && (!user.twoFactorEnabled || user.mustChangePassword)) {
      // The dashboard uses this to send the user to 2FA enrolment / password change.
      claims.setup = { twoFactor: !user.twoFactorEnabled, changePassword: !!user.mustChangePassword };
    }
    return claims;
  };
}
