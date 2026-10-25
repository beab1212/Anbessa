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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Permissions whose execution must be approved by a different person (Role.md §11). */
export const APPROVAL_PERMISSIONS: readonly Permission[] = [
  "refund:approve", "payout:approve", "pricing:approve", "incentive:approve", "role:approve",
  "topup:approve_cash", "adjustment:approve", "writeoff:approve", "commission_rule:approve",
  "balance_policy:approve", "policy_override:approve",
];
