// Role → permission matrix: docs/design/Role.md §8 and docs/design/Payment.md §15.
// Scope letters: S = own data, O = own organisation, C = assigned city, G = everywhere.
// This is the single source of truth; auth-service generates Better Auth's
// access-control statements from it, and every service authorizes with it.

import type { Permission } from "./permissions.js";
import type { RoleCode } from "./roles.js";

export type ScopeLetter = "S" | "O" | "C" | "G";

type Grants = Partial<Record<Permission, ScopeLetter>>;

const each = (scope: ScopeLetter, ...permissions: Permission[]): Grants =>
  Object.fromEntries(permissions.map((p) => [p, scope]));

export const MATRIX: Record<RoleCode, Grants> = {
  RIDER: each("S",
    "trip:create", "trip:read", "trip:cancel", "location:read_live", "driver:apply",
    "payment:read", "ticket:create", "sos:trigger"),

  DRIVER: each("S",
    "trip:read", "trip:cancel", "trip:accept", "trip:update_status", "location:stream",
    "vehicle:register", "vehicle:retire", "document:upload", "earnings:read",
    "balance:read", "topup:create", "ticket:create", "sos:trigger"),

  FLEET_OWNER: each("O",
    "trip:read", "location:read_live", "vehicle:register", "vehicle:read", "vehicle:authorize_driver", "vehicle:retire",
    "driver:read", // onboarding status of the fleet's own drivers
    "document:upload", "org:update", "org:manage_members", "earnings:read", "payment:read",
    "balance:read", "topup:create", "ticket:create", "sos:trigger"),

  // Attribute roles (Role.md §4): they mark membership, they don't administer.
  FLEET_DRIVER: {},
  CORPORATE_EMPLOYEE: each("O", "trip:bill_corporate"),

  CORPORATE_ADMIN: each("O",
    "trip:create", "trip:create_on_behalf", "trip:read", "trip:cancel", "trip:bill_corporate",
    "document:upload", "org:update", "org:manage_members", "corporate:manage_policies",
    "corporate:read_invoices", "payment:read", "ticket:create", "sos:trigger"),

  CORPORATE_COORDINATOR: each("O",
    "trip:create", "trip:create_on_behalf", "trip:read", "trip:cancel", "trip:bill_corporate",
    "ticket:create", "sos:trigger"),

  CALL_CENTER_AGENT: each("C",
    "trip:read", "trip:create_on_behalf", "trip:cancel", "user:create_guest", "user:read_masked",
    "refund:request", "ticket:create", "ticket:read", "ticket:update", "lost_item:manage"),

  DISPATCHER: each("C",
    "trip:read", "trip:cancel", "trip:assign", "trip:reassign", "trip:read_gps_trace",
    "location:read_live", "user:read_masked", "ticket:read", "ticket:update", "sos:respond", "report:read"),

  SUPPORT_AGENT: each("C",
    "trip:read", "trip:cancel", "user:read_masked", "user:read_pii", "refund:request",
    "adjustment:request", "balance:read", "ticket:create", "ticket:read", "ticket:update",
    "lost_item:manage", "report:read"),

  ONBOARDING_OFFICER: each("C",
    "user:read_masked", "user:read_pii", "driver:read", "driver:verify", "driver:activate",
    "driver:suspend", "driver:reinstate", "vehicle:read", "vehicle:verify", "vehicle:transfer",
    "document:read", "document:review", "org:read", "org:verify", "policy_override:request",
    "ticket:read", "ticket:update", "report:read"),

  SAFETY_OFFICER: each("C",
    "trip:read", "trip:cancel", "trip:read_gps_trace", "location:read_live", "user:read_masked",
    "user:read_pii", "user:suspend", "user:reinstate", "driver:read", "driver:suspend", "driver:reinstate", "vehicle:read",
    "org:suspend", "refund:request", "ticket:read", "ticket:update", "sos:respond",
    "incident:manage", "report:read"),

  OPERATIONS_MANAGER: each("C",
    "trip:read", "user:read_masked", "zone:manage", "vehicle_type:manage", "pricing:propose",
    "pricing:approve", "incentive:propose", "commission_rule:propose", "balance_policy:propose",
    "report:read"),

  MARKETING: each("C", "user:read_masked", "promo:manage", "campaign:send", "report:read"),

  ANALYST: each("C", "trip:read", "user:read_masked", "report:read"),

  FINANCE_OFFICER: each("G",
    "trip:read", "user:read_masked", "user:read_pii", "org:suspend", "refund:request",
    "payout:prepare", "commission:read", "commission:collect", "invoice:issue", "balance:read",
    "topup:record_cash", "adjustment:request", "writeoff:request", "ticket:read", "ticket:update",
    "report:read", "report:read_finance"),

  FINANCE_MANAGER: each("G",
    "trip:read", "user:read_masked", "user:read_pii", "refund:approve", "payout:approve",
    "commission:read", "commission:collect", "pricing:approve", "incentive:approve", "balance:read",
    "topup:approve_cash", "adjustment:approve", "writeoff:approve", "commission_rule:approve",
    "balance_policy:approve", "policy_override:approve", "report:read", "report:read_finance"),

  SUPER_ADMIN: each("G", "user:read_masked", "staff:manage", "role:request", "role:approve", "audit_log:read"),

  AUDITOR: each("G", "audit_log:read", "report:read", "report:read_finance", "report:read_regulatory"),

  REGULATOR: each("G", "report:read_regulatory"),
};
