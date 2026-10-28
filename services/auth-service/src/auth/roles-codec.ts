import { roleByStored, type OrgKind, type RoleAssignment } from "@ride-app/shared-authz";

// Better Auth stores several roles as a comma-separated string (user.role, member.role).

export function splitRoles(stored: string | null | undefined): string[] {
  return (stored ?? "").split(",").map((r) => r.trim()).filter(Boolean);
}

export function joinRoles(roles: Iterable<string>): string {
  return [...new Set(roles)].sort().join(",");
}

export interface MembershipRow {
  role: string;
  validUntil: Date | null;
  organization: { id: string; kind: string; cityId: string; status: string };
}

/**
 * Turn stored Better Auth data into scoped role assignments (Auth.md §7):
 * user.role → SELF (customer) / GLOBAL (staff); FLEET/CORPORATE member → ORG; STAFF_CITY member → CITY.
 * Anything unknown, expired or in the wrong kind of organisation is ignored.
 */
export function toAssignments(userRole: string | null | undefined, memberships: MembershipRow[], now = new Date()): RoleAssignment[] {
  const out: RoleAssignment[] = [];
  for (const stored of splitRoles(userRole)) {
    const info = roleByStored(stored);
    if (!info || info.archived || info.storage.type !== "user") continue;
    out.push({ role: info.code, scope: info.audience === "ride-admin" ? "GLOBAL" : "SELF" });
  }
  for (const m of memberships) {
    if (m.validUntil && m.validUntil <= now) continue;
    if (m.organization.status === "SUSPENDED") continue;
    const kind = m.organization.kind as OrgKind;
    for (const stored of splitRoles(m.role)) {
      const info = roleByStored(stored);
      if (!info || info.archived) continue;
      const role = info.code;
      const storage = info.storage;
      if (storage.type !== "member" || !(storage.orgKinds as readonly OrgKind[]).includes(kind)) continue;
      if (kind === "STAFF_CITY") out.push({ role, scope: "CITY", cityId: m.organization.cityId });
      else if (kind === "FLEET" || kind === "CORPORATE") {
        // Partner organisations must be verified before their roles mean anything. The founder
        // (owner / admin) keeps the role while it waits, marked pending: shared-authz then grants
        // only what onboarding needs (PENDING_ORG_PERMISSIONS), never trips, money or live data.
        if (m.organization.status !== "VERIFIED") {
          if (role === "FLEET_OWNER" || role === "CORPORATE_ADMIN") out.push({ role, scope: "ORG", orgId: m.organization.id, pending: true });
          continue;
        }
        out.push({ role, scope: "ORG", orgId: m.organization.id });
      }
    }
  }
  return out;
}
