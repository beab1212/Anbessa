// Permission catalog: docs/design/Role.md §7 plus docs/design/Payment.md §15.

export const PERMISSIONS = [
  // trips
  "trip:create", "trip:create_on_behalf", "trip:read", "trip:cancel", "trip:accept",
  "trip:update_status", "trip:assign", "trip:reassign", "trip:read_gps_trace", "trip:bill_corporate",
  // live location
  "location:stream", "location:read_live",
  // users
  "user:read_masked", "user:read_pii", "user:create_guest", "user:suspend", "user:reinstate",
  // drivers
  "driver:apply", "driver:read", "driver:verify", "driver:activate", "driver:suspend", "driver:reinstate",
  // vehicles
  "vehicle:register", "vehicle:read", "vehicle:verify", "vehicle:authorize_driver", "vehicle:retire", "vehicle:transfer",
  // documents
  "document:upload", "document:read", "document:review",
  // organisations
  "org:create", "org:read", "org:update", "org:verify", "org:manage_members", "org:suspend",
  // corporate
  "corporate:manage_policies", "corporate:read_invoices",
  // earnings, payments, balances (Payment.md §15)
  "earnings:read", "payment:read", "refund:request", "refund:approve", "payout:prepare", "payout:approve",
  "commission:read", "commission:collect", "invoice:issue",
  "balance:read", "topup:create", "topup:record_cash", "topup:approve_cash",
  "adjustment:request", "adjustment:approve", "writeoff:request", "writeoff:approve",
  "commission_rule:propose", "commission_rule:approve", "balance_policy:propose", "balance_policy:approve",
  "policy_override:request", "policy_override:approve",
  // pricing and ops
  "zone:manage", "vehicle_type:manage", "pricing:propose", "pricing:approve", "incentive:propose", "incentive:approve",
  // marketing
  "promo:manage", "campaign:send",
  // support and safety
  "ticket:create", "ticket:read", "ticket:update", "lost_item:manage", "sos:trigger", "sos:respond", "incident:manage",
  // administration
  "staff:manage", "role:request", "role:approve", "audit_log:read",
  "report:read", "report:read_finance", "report:read_regulatory",
  // platform administration: the permission matrix, live settings, cities, announcements, system health
  "authz:read", "authz:propose", "authz:approve", "settings:read", "settings:propose", "settings:approve",
  "city:manage", "announcement:manage", "system:read", "session:revoke",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Permissions whose execution must be approved by a different person (Role.md §11). */
export const APPROVAL_PERMISSIONS: readonly Permission[] = [
  "refund:approve", "payout:approve", "pricing:approve", "incentive:approve", "role:approve",
  "topup:approve_cash", "adjustment:approve", "writeoff:approve", "commission_rule:approve",
  "balance_policy:approve", "policy_override:approve", "authz:approve", "settings:approve",
];

/**
 * What a role held in a partner organisation that isn't verified yet may still do: finish onboarding
 * (the company profile, its documents and vehicles, its members, a support ticket). Everything else —
 * booking or billing trips, on-behalf booking, payments and balances, authorizing drivers, live
 * location, other people's data — waits for verification. A fixed list in code, not part of the
 * editable matrix: authorize() applies it to every pending assignment whatever the matrix says.
 */
export const PENDING_ORG_PERMISSIONS: readonly Permission[] = [
  "org:update", "org:manage_members", "document:upload", "vehicle:register", "vehicle:read", "ticket:create",
];

/** Groups for screens that list permissions (the admin matrix editor). */
export const PERMISSION_GROUPS: { name: string; prefixes: string[] }[] = [
  { name: "Trips", prefixes: ["trip"] },
  { name: "Live location", prefixes: ["location"] },
  { name: "Users", prefixes: ["user", "session"] },
  { name: "Drivers and vehicles", prefixes: ["driver", "vehicle", "document"] },
  { name: "Organisations", prefixes: ["org", "corporate"] },
  { name: "Money", prefixes: ["earnings", "payment", "refund", "payout", "commission", "invoice", "balance", "topup", "adjustment", "writeoff", "commission_rule", "balance_policy", "policy_override"] },
  { name: "Pricing and operations", prefixes: ["zone", "vehicle_type", "pricing", "incentive"] },
  { name: "Marketing", prefixes: ["promo", "campaign"] },
  { name: "Support and safety", prefixes: ["ticket", "lost_item", "sos", "incident"] },
  { name: "Administration", prefixes: ["staff", "role", "audit_log", "report", "authz", "settings", "city", "announcement", "system"] },
];

export function permissionGroup(permission: string): string {
  const prefix = permission.split(":")[0]!;
  return PERMISSION_GROUPS.find((g) => g.prefixes.includes(prefix))?.name ?? "Other";
}

export const isPermission = (value: string): value is Permission => (PERMISSIONS as readonly string[]).includes(value);
