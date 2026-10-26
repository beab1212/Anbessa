// Better Auth hooks that enforce our rules on organisations and memberships
// (Auth.md §7, §9.3, Role.md §5). They run for every path into Better Auth:
// HTTP endpoints and server-side API calls alike.

import { APIError } from "better-auth/api";
import { ROLES, roleFromStored, rolesForOrgKind, type OrgKind } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { emailToPhone } from "./password.js";
import { splitRoles } from "./roles-codec.js";

const PARTNER_KINDS: OrgKind[] = ["FLEET", "CORPORATE"];
const isStaffKind = (kind: unknown) => kind === "STAFF_CITY" || kind === "STAFF_HQ";
const TIN = /^\d{10}$/;

const forbid = (message: string) => new APIError("FORBIDDEN", { message });
const bad = (message: string) => new APIError("BAD_REQUEST", { message });

function assertRolesAllowed(kind: OrgKind, roleField: string) {
  const allowed = new Set<string>(rolesForOrgKind(kind).map((c) => ROLES[c].stored));
  const roles = splitRoles(roleField);
  if (roles.length === 0 || roles.some((r) => !allowed.has(r))) {
    throw bad(`role(s) "${roleField}" not allowed in a ${kind} organization`);
  }
}

/** Staff organisations never change through Better Auth: grants and revocations are
 * executed by the identity service in one transaction, after maker–checker approval. */
function assertNotStaff(kind: unknown, what: string) {
  if (isStaffKind(kind)) throw forbid(`${what} on staff organizations go through /api/identity approvals`);
}

async function bumpPermissionVersion(db: Db, userId: string) {
  await db.user.update({ where: { id: userId }, data: { permissionVersion: { increment: 1 } } });
}

export function createOrganizationHooks(db: Db) {
  return {
    async beforeCreateOrganization({ organization, user }: { organization: Record<string, unknown>; user: Record<string, unknown> }) {
      const kind = organization.kind as OrgKind;
      if (!PARTNER_KINDS.includes(kind)) throw forbid("only FLEET and CORPORATE organizations can be created");
      if (user.banned || user.accountStatus !== "ACTIVE") throw forbid("account cannot create organizations");
      const cityId = String(organization.cityId ?? "");
      if (!(await db.city.findUnique({ where: { id: cityId } }))) throw bad("unknown cityId");
      if (!organization.legalName || typeof organization.legalName !== "string") throw bad("legalName is required");
      if (!TIN.test(String(organization.tin ?? ""))) throw bad("tin must be 10 digits");
      // checked here, before Better Auth writes the row: the unique index would otherwise surface as a 500
      if (await db.organization.findFirst({ where: { kind, tin: String(organization.tin) }, select: { id: true } })) {
        throw bad("a company with this TIN is already registered");
      }
      // status is never client-controlled
      return { data: { ...organization, status: "PENDING" } };
    },

    async afterCreateOrganization({ organization, user }: { organization: Record<string, unknown>; user: { id: string } }) {
      await bumpPermissionVersion(db, user.id);
      await writeOutbox(db,
        { topic: "org.created", key: String(organization.id), payload: { orgId: String(organization.id), kind: String(organization.kind), cityId: String(organization.cityId) } },
        audit({ actorId: user.id, action: "org:create", resource: { type: "organization", id: String(organization.id) }, outcome: "EXECUTED" }),
      );
    },

    async beforeUpdateOrganization({ organization, member }: { organization: Record<string, unknown>; member: { organizationId: string } }) {
      for (const field of ["kind", "cityId", "tin", "status", "legalName"]) {
        if (field in organization) throw forbid(`${field} can only be changed through /api/identity`);
      }
      const org = await db.organization.findUnique({ where: { id: member.organizationId } });
      assertNotStaff(org?.kind, "updates");
    },

    async beforeAddMember({ member, organization }: { member: { userId: string; role: string }; organization: Record<string, unknown> }) {
      const kind = organization.kind as OrgKind;
      assertNotStaff(kind, "memberships");
      // The creator is added with the fixed creatorRole (fleet_owner). For a company account the
      // creator is its admin: switch the role before the member is written.
      if (kind === "CORPORATE" && member.role === ROLES.FLEET_OWNER.stored) {
        const hasMembers = await db.member.count({ where: { organizationId: String(organization.id) } });
        if (hasMembers === 0) return { data: { role: ROLES.CORPORATE_ADMIN.stored } };
      }
      assertRolesAllowed(kind, member.role);
    },

    async afterAddMember({ member, organization }: { member: { userId: string; role: string }; organization: Record<string, unknown> }) {
      await bumpPermissionVersion(db, member.userId);
      await writeOutbox(db, ...splitRoles(member.role).map((stored) => ({
        topic: "role.granted" as const,
        key: member.userId,
        payload: {
          userId: member.userId,
          role: roleFromStored(stored) ?? stored,
          orgId: String(organization.id),
          byUserId: null,
        },
      })));
    },

    async beforeUpdateMemberRole({ member, newRole }: { member: { organizationId: string }; newRole: string }) {
      const org = await db.organization.findUnique({ where: { id: member.organizationId } });
      if (!org) throw bad("organization not found");
      assertNotStaff(org.kind, "role changes");
      assertRolesAllowed(org.kind as OrgKind, newRole);
    },

    async afterUpdateMemberRole({ member }: { member: { userId: string } }) {
      await bumpPermissionVersion(db, member.userId);
    },

    async beforeRemoveMember({ organization }: { organization: Record<string, unknown> }) {
      assertNotStaff(organization.kind, "removals");
    },

    async afterRemoveMember({ member, organization }: { member: { userId: string; role: string }; organization: Record<string, unknown> }) {
      await bumpPermissionVersion(db, member.userId);
      await writeOutbox(db, ...splitRoles(member.role).map((stored) => ({
        topic: "role.revoked" as const,
        key: member.userId,
        payload: {
          userId: member.userId,
          role: roleFromStored(stored) ?? stored,
          orgId: String(organization.id),
          byUserId: null,
        },
      })));
    },

    async beforeCreateInvitation({ invitation, organization }: { invitation: { role: string; email: string }; organization: Record<string, unknown> }) {
      if (isStaffKind(organization.kind)) throw forbid("staff organizations don't use invitations");
      if (organization.status !== "VERIFIED") throw forbid("the organization must be verified before inviting members");
      assertRolesAllowed(organization.kind as OrgKind, invitation.role);
    },

    async afterCreateInvitation({ invitation, organization }: { invitation: { id: string; role?: string | null; email: string }; organization: Record<string, unknown> }) {
      // notification-service turns this into an SMS for phone-only invitees
      await writeOutbox(db, {
        topic: "org.member_invited",
        key: String(organization.id),
        payload: {
          invitationId: invitation.id,
          orgId: String(organization.id),
          orgName: String(organization.name ?? ""), // a company name, shown in the invitation SMS
          role: invitation.role ?? "",
          phoneNumber: emailToPhone(invitation.email),
        },
      });
    },

    async beforeAcceptInvitation({ organization }: { organization: Record<string, unknown> }) {
      if (organization.status === "SUSPENDED") throw forbid("organization is suspended");
    },
  };
}
