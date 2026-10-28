// Kafka event payload contracts. Keeping these in one shared package means a
// producer and consumer in two different services can't silently drift apart.
// Every event also carries the envelope { eventId, version, at } (architecture §8).
export interface EventEnvelope {
  eventId: string;
  version: number;
  /** ISO 8601 */
  at: string;
}

/** realtime-gateway → `driver.location` (key driverId). Accepted pings only. */
export interface DriverLocationEvent {
  driverId: string;
  /** set while the driver is on a trip (from location state, never from the client) */
  tripId?: string;
  cityId: string;
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  accuracy?: number;
  /** device time, unix ms */
  at: number;
}

/** fleet-service → `driver.online` (key driverId), when a driving session starts (workflow 04). */
export interface DriverOnlineEvent extends EventEnvelope {
  driverId: string;
  vehicleId: string;
  vehicleType: string;
  cityId: string;
  /** fleet organisation owning the vehicle; absent for owner-drivers */
  fleetOrgId?: string;
  beneficiaryId?: string;
  balanceState?: BalanceState;
  cashAllowed: boolean;
}

/** fleet-service → `driver.offline` (key driverId), when the session ends. */
export interface DriverOfflineEvent extends EventEnvelope {
  driverId: string;
  reason: "DRIVER" | "CONNECTION_LOST" | "BALANCE_BLOCKED" | "SUSPENDED" | "VEHICLE_UNAVAILABLE" | "FLEET_SUSPENDED";
}

/** location-service → `driver.connection_lost` (key driverId): no ping for 10 min and no trip. fleet-service ends the session. */
export interface DriverConnectionLostEvent extends EventEnvelope {
  driverId: string;
  cityId: string;
  lastSeenAt: string;
}

/** trip-service → `trip.matched` (key tripId). */
export interface TripMatchedEvent extends EventEnvelope {
  tripId: string;
  riderId: string;
  driverId: string;
  cityId: string;
  vehicleType: string;
  /** who booked it, when not the rider (phone or company booking) */
  bookedById?: string;
  /** the company it's billed to (corporate trips) */
  billingOrgId?: string;
}

export type PaymentMethod = "CASH" | "MOBILE_MONEY" | "CARD" | "CORPORATE";

/** Who earns the trip (Payment.md D1): the fleet company for ORGANIZATION vehicles, else the driver. */
export interface Beneficiary {
  type: "INDIVIDUAL" | "ORGANIZATION";
  id: string;
}

/** trip-service → `trip.requested` (key tripId). */
export interface TripRequestedEvent extends EventEnvelope {
  tripId: string;
  riderId: string;
  bookedById: string;
  cityId: string;
  vehicleType: string;
  channel: "APP" | "PHONE" | "CORPORATE_PORTAL";
  paymentMethod: PaymentMethod;
  fareEstimateMinor: number;
}

/** trip-service → `trip.driver_en_route` / `trip.driver_arrived` / `trip.started` (key tripId). */
export interface TripProgressEvent extends EventEnvelope {
  tripId: string;
  riderId: string;
  driverId: string;
  cityId: string;
}

/** trip-service → `trip.completed` / `trip.cancelled` (key tripId). */
export interface TripEndedEvent extends EventEnvelope {
  tripId: string;
  riderId: string;
  driverId?: string;
}

/** trip-service → `trip.completed`: everything payment-service needs to settle (Payment.md §6). */
export interface TripCompletedEvent extends TripEndedEvent {
  driverId: string;
  cityId: string;
  vehicleType: string;
  vehicleId: string;
  beneficiary: Beneficiary;
  paymentMethod: PaymentMethod;
  billingType: "PERSONAL" | "CORPORATE";
  billingOrgId?: string;
  /** final fare in minor units (santim), waiting fee included. The full fare: the driver's earning is computed on it */
  fareMinor: number;
  waitingFeeMinor: number;
  /** the pricing-service quote the trip was booked with (finds the promo reservation) */
  quoteId?: string;
  /** promo discount given to the rider (0 or absent = none, never above fareMinor); the rider pays fareMinor − promoDiscountMinor */
  promoDiscountMinor?: number;
  currency: string;
  distanceMeters: number;
  durationSeconds: number;
  completedAt: string;
}

/** trip-service → `trip.cancelled` (workflow 07). */
export interface TripCancelledEvent extends TripEndedEvent {
  cityId: string;
  by: "RIDER" | "DRIVER" | "SYSTEM" | "STAFF";
  reason: string;
  paymentMethod: PaymentMethod;
  /** charged to the rider; 0 when free */
  feeMinor: number;
  /** credited to the beneficiary out of the fee */
  driverCompensationMinor: number;
  beneficiary?: Beneficiary;
  /** company account trips: the fee is billed to the company */
  billingOrgId?: string;
  /** the pricing-service quote the trip was booked with (releases its promo reservation) */
  quoteId?: string;
  currency: string;
}

/** auth-service → `user.created` (key userId). */
export interface UserCreatedEvent extends EventEnvelope {
  userId: string;
  /** created by the call center (phone only, not yet claimed) */
  guest: boolean;
}

// ── payment-service (Payment.md, workflows 08–09) ─────────────────────────────

export type BalanceState = "OK" | "WARNING" | "CASH_BLOCKED" | "BLOCKED";

/** payment-service → `balance.state_changed` (key beneficiary id). location-service updates matching; notification tells the driver. */
export interface BalanceStateChangedEvent extends EventEnvelope {
  accountId: string;
  beneficiary: Beneficiary;
  cityId: string;
  state: BalanceState;
  previousState: BalanceState;
  /** OK and WARNING may take cash trips */
  cashAllowed: boolean;
  balanceMinor: number;
}

/** payment-service → `payment.action_required` (key riderId): the rider must approve the charge with their provider. */
export interface PaymentActionRequiredEvent extends EventEnvelope {
  paymentId: string;
  tripId: string;
  riderId: string;
  purpose: "TRIP_FARE" | "CANCELLATION_FEE";
  provider: string;
  amountMinor: number;
  currency: string;
  checkoutUrl: string | null;
}

/** payment-service → `payment.captured` / `payment.failed` (key riderId). */
export interface PaymentOutcomeEvent extends EventEnvelope {
  paymentId: string;
  tripId: string;
  riderId: string;
  purpose: "TRIP_FARE" | "CANCELLATION_FEE";
  provider: string;
  method: PaymentMethod;
  amountMinor: number;
  currency: string;
  /** payment.failed: no retry left (settled as a rider receivable) */
  final?: boolean;
  nextAttemptAt?: string;
}

/** payment-service → `trip.settled` (key tripId): the ledger entry for a trip, any payment method (the receipt). */
export interface TripSettledEvent extends EventEnvelope {
  tripId: string;
  riderId: string;
  driverId?: string;
  beneficiary?: Beneficiary;
  purpose: "TRIP_FARE" | "CANCELLATION_FEE";
  paymentMethod: PaymentMethod;
  fareMinor: number;
  commissionMinor: number;
  vatMinor: number;
  /** what the beneficiary's balance moved by (negative on cash trips) */
  earningsMinor: number;
  /** promo discount the platform paid (booked to PROMO_EXPENSE); the rider paid fareMinor − promoDiscountMinor. 0 or absent = none */
  promoDiscountMinor?: number;
  currency: string;
}

/** payment-service → `balance.topped_up` / `balance.payment_due` / `payout.sent` / `payout.failed` (key beneficiary id). */
export interface BalanceMoneyEvent extends EventEnvelope {
  accountId: string;
  beneficiary: Beneficiary;
  amountMinor: number;
  balanceMinor: number;
  currency: string;
  channel?: string;
  provider?: string;
  /** balance.payment_due */
  minimumMinor?: number;
  dueAt?: string;
  failure?: string;
}

/** payment-service → `refund.succeeded` / `refund.failed` (key riderId). */
export interface RefundOutcomeEvent extends EventEnvelope {
  refundId: string;
  paymentId: string;
  tripId: string;
  riderId: string;
  amountMinor: number;
  currency: string;
}

// ── support-service (workflows 13 and 14) ─────────────────────────────────────

/** Topics support-service publishes (outbox). `audit.recorded` is shared with every service. */
export const SUPPORT_TOPICS = {
  ticketCreated: "ticket.created",
  ticketResolved: "ticket.resolved",
  ticketClosed: "ticket.closed",
  lostItemReturned: "lost_item.returned",
  sosTriggered: "sos.triggered",
  sosAcknowledged: "sos.acknowledged",
  sosResolved: "sos.resolved",
  incidentOpened: "incident.opened",
  incidentResolved: "incident.resolved",
} as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[keyof typeof SUPPORT_TOPICS];

export type TicketCategory = "SAFETY" | "PAYMENT" | "TRIP" | "LOST_ITEM" | "ACCOUNT" | "FEEDBACK";
export type TicketPriority = "P1" | "P2" | "P3" | "P4";
export type TicketResolution = "NO_ACTION" | "EXPLAINED" | "REFUND" | "ADJUSTMENT" | "DRIVER_WARNING" | "ESCALATE_SAFETY";

/** support-service → `ticket.created` (key ticketId). */
export interface TicketCreatedEvent extends EventEnvelope {
  ticketId: string;
  ref: number;
  cityId: string;
  category: TicketCategory;
  priority: TicketPriority;
  source: "APP" | "PHONE" | "STAFF" | "SYSTEM";
  requesterUserId: string;
  tripId?: string;
  firstResponseDueAt: string;
}

/** support-service → `ticket.resolved` (key ticketId). The requester gets the outcome (notification-service, later). */
export interface TicketResolvedEvent extends EventEnvelope {
  ticketId: string;
  cityId: string;
  category: TicketCategory;
  requesterUserId: string;
  tripId?: string;
  resolution: TicketResolution;
  /** null when resolved automatically (no reply from the requester in 72 h) */
  byUserId: string | null;
}

/** support-service → `ticket.closed` (key ticketId). */
export interface TicketClosedEvent extends EventEnvelope {
  ticketId: string;
  cityId: string;
  requesterUserId: string;
  /** true when closed by the 7-day sweep */
  automatic: boolean;
  byUserId: string | null;
}

/** support-service → `lost_item.returned` (key lostItemId). */
export interface LostItemReturnedEvent extends EventEnvelope {
  lostItemId: string;
  ticketId: string;
  tripId: string;
  cityId: string;
  riderUserId: string;
  driverUserId?: string;
  byUserId: string;
}

/** support-service → `sos.triggered` (key alertId): the highest-priority path (workflow 14). */
export interface SosTriggeredEvent extends EventEnvelope {
  alertId: string;
  cityId: string;
  tripId: string;
  /** who pressed SOS */
  userId: string;
  role: "RIDER" | "DRIVER";
  source: "APP" | "SYSTEM";
  lat: number;
  lng: number;
  triggeredAt: string;
  riderUserId?: string;
  driverUserId?: string;
  /** false when trip-service couldn't be reached and the alert was accepted on the app's word */
  tripVerified: boolean;
}

/** support-service → `sos.acknowledged` (key alertId). */
export interface SosAcknowledgedEvent extends EventEnvelope {
  alertId: string;
  cityId: string;
  tripId: string;
  userId: string;
  byUserId: string;
  acknowledgedAt: string;
}

/** support-service → `sos.resolved` (key alertId). */
export interface SosResolvedEvent extends EventEnvelope {
  alertId: string;
  cityId: string;
  tripId: string;
  userId: string;
  outcome: "FALSE_ALARM" | "ASSISTED" | "ESCALATED";
  byUserId: string;
  resolvedAt: string;
  incidentId?: string;
}

export type IncidentCategory = "HARASSMENT" | "ASSAULT" | "ACCIDENT" | "DANGEROUS_DRIVING" | "THEFT" | "OTHER";
export type IncidentSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type IncidentOutcome = "CLEARED" | "WARNING" | "SUSPENDED_TEMPORARY" | "REMOVED_PERMANENTLY";

/** support-service → `incident.opened` (key incidentId). */
export interface IncidentOpenedEvent extends EventEnvelope {
  incidentId: string;
  ref: number;
  cityId: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  source: "SOS" | "TICKET" | "MANUAL";
  tripId?: string;
  subjectUserIds: string[];
  sosAlertId?: string;
  ticketId?: string;
  /** null when opened automatically (a SAFETY ticket) */
  byUserId: string | null;
}

/** support-service → `incident.resolved` (key incidentId). Suspensions themselves are auth-service's `user.suspended`. */
export interface IncidentResolvedEvent extends EventEnvelope {
  incidentId: string;
  cityId: string;
  outcome: IncidentOutcome;
  subjectUserIds: string[];
  byUserId: string;
}

// ── trip-service: scheduled rides, reassignment, corporate policies (workflows 05, 11, 12) ──

/** Topics trip-service publishes besides the trip lifecycle ones above (outbox). `audit.recorded` is shared. */
export const TRIP_EXTRA_TOPICS = {
  scheduled: "trip.scheduled",
  scheduleCancelled: "trip.schedule_cancelled",
  scheduleFailed: "trip.schedule_failed",
  dispatchEscalated: "trip.dispatch_escalated",
  reassigned: "trip.reassigned",
  corporatePolicyUpdated: "corporate.policy_updated",
} as const;
export type TripExtraTopic = (typeof TRIP_EXTRA_TOPICS)[keyof typeof TRIP_EXTRA_TOPICS];

/** trip-service → `trip.scheduled` (key scheduledTripId): a ride booked ahead (workflow 12 step 3). */
export interface TripScheduledEvent extends EventEnvelope {
  scheduledTripId: string;
  riderId: string;
  bookedById: string;
  cityId: string;
  vehicleType: string;
  channel: "APP" | "PHONE" | "CORPORATE_PORTAL";
  paymentMethod: PaymentMethod;
  billingOrgId?: string;
  fareEstimateMinor: number;
  currency: string;
  /** ISO 8601: the pickup time */
  scheduledFor: string;
  /** ISO 8601: when matching starts (scheduledFor − lead time) */
  matchAt: string;
  /** true when this replaces an earlier version of the booking (time, route or payment edited) */
  updated?: boolean;
}

/** trip-service → `trip.schedule_cancelled` (key scheduledTripId): cancelled before dispatch (always free). */
export interface TripScheduleCancelledEvent extends EventEnvelope {
  scheduledTripId: string;
  riderId: string;
  bookedById: string;
  cityId: string;
  by: "RIDER" | "STAFF" | "BOOKER";
  byUserId: string;
  scheduledFor: string;
}

/** trip-service → `trip.schedule_failed` (key scheduledTripId): the trip couldn't be created at dispatch time. */
export interface TripScheduleFailedEvent extends EventEnvelope {
  scheduledTripId: string;
  riderId: string;
  bookedById: string;
  cityId: string;
  /** e.g. RIDER_HAS_ACTIVE_TRIP */
  reason: string;
  scheduledFor: string;
}

/** trip-service → `trip.dispatch_escalated` (key tripId): a scheduled trip is still unmatched near pickup (workflow 12 step 8). */
export interface TripDispatchEscalatedEvent extends EventEnvelope {
  tripId: string;
  scheduledTripId: string;
  riderId: string;
  cityId: string;
  vehicleType: string;
  scheduledFor: string;
}

/** trip-service → `trip.reassigned` (key tripId): a dispatcher took a matched trip from its driver (trip:reassign). */
export interface TripReassignedEvent extends EventEnvelope {
  tripId: string;
  riderId: string;
  cityId: string;
  fromDriverId: string;
  /** absent when the trip went back to matching */
  toDriverId?: string;
  byUserId: string;
  reason?: string;
}

/** trip-service → `corporate.policy_updated` (key orgId): a company's ride policy changed (workflow 11 step 4). */
export interface CorporatePolicyUpdatedEvent extends EventEnvelope {
  orgId: string;
  byUserId: string;
  allowedVehicleTypes: string[];
  /** 0 = Sunday … 6 = Saturday; empty = every day */
  allowedDays: number[];
  /** minutes after midnight, Addis Ababa time; null = any time */
  startMinute: number | null;
  endMinute: number | null;
  maxFareMinor: number | null;
  monthlyBudgetMinor: number | null;
  requirePurpose: boolean;
}

// ── payment-service: money controls (Payment.md §15–§16, workflows 09, 11, 13, 15) ──

/** Topics payment-service publishes for adjustments, write-offs, incentives and corporate invoices. */
export const PAYMENT_CONTROL_TOPICS = {
  balanceAdjusted: "balance.adjusted",
  balanceWrittenOff: "balance.written_off",
  incentiveAwarded: "incentive.awarded",
  invoiceIssued: "invoice.issued",
  invoicePaid: "invoice.paid",
  payoutMethodChanged: "payout_method.changed",
} as const;
export type PaymentControlTopic = (typeof PAYMENT_CONTROL_TOPICS)[keyof typeof PAYMENT_CONTROL_TOPICS];

/** payment-service → `balance.adjusted` (key beneficiary owner id): an approved manual credit or debit. */
export interface BalanceAdjustedEvent extends EventEnvelope {
  adjustmentId: string;
  accountId: string;
  beneficiary: Beneficiary;
  direction: "CREDIT" | "DEBIT";
  /** always positive; `direction` says which way the balance moved */
  amountMinor: number;
  category: "GOODWILL" | "FEE_REVERSAL" | "CORRECTION" | "LOST_ITEM_RETURN" | "OTHER";
  balanceMinor: number;
  currency: string;
  tripId?: string;
  ticketId?: string;
}

/** payment-service → `balance.written_off` (key beneficiary owner id): an approved write-off of uncollectable debt. */
export interface BalanceWrittenOffEvent extends EventEnvelope {
  writeOffId: string;
  accountId: string;
  beneficiary: Beneficiary;
  amountMinor: number;
  balanceMinor: number;
  currency: string;
}

/** payment-service → `incentive.awarded` (key beneficiary owner id): a driver reached an incentive's target. */
export interface IncentiveAwardedEvent extends EventEnvelope {
  awardId: string;
  programId: string;
  programName: string;
  cityId: string;
  /** who drove the trips; the money goes to `beneficiary` (the driver, or their fleet) */
  driverId: string;
  accountId: string;
  beneficiary: Beneficiary;
  trips: number;
  amountMinor: number;
  balanceMinor: number;
  currency: string;
}

/**
 * payment-service → `payout_method.changed` (key beneficiary owner id): where a balance's payouts
 * go was set or changed. Payouts wait until `payoutsResumeAt` (cooling-off), so the owner can
 * react if it wasn't them. Destinations are masked (last four digits only).
 */
export interface PayoutMethodChangedEvent extends EventEnvelope {
  accountId: string;
  beneficiary: Beneficiary;
  provider: string;
  /** e.g. "•••1234" */
  destinationMasked: string;
  previousProvider: string | null;
  previousDestinationMasked: string | null;
  /** who made the change (the owner, or a member of the owning organisation) */
  changedBy: string;
  changedAt: string;
  /** payouts to the new method start after this (ISO 8601) */
  payoutsResumeAt: string;
}

/** payment-service → `invoice.issued` / `invoice.paid` (key orgId): a company's monthly invoice. */
export interface InvoiceEvent extends EventEnvelope {
  invoiceId: string;
  orgId: string;
  number: string;
  /** YYYY-MM (Addis Ababa calendar month) */
  period: string;
  totalMinor: number;
  paidMinor: number;
  currency: string;
  dueAt: string;
  /** invoice.paid */
  paidAt?: string;
}

// ── pricing-service (workflow 15: zones, fare rules, promotions) ──────────────

/** Topics pricing-service publishes (outbox). `audit.recorded` is shared with every service. */
export const PRICING_TOPICS = {
  ruleScheduled: "pricing.rule_scheduled",
  ruleActivated: "pricing.rule_activated",
  zoneChanged: "pricing.zone_changed",
  promoActivated: "promo.activated",
  promoRedeemed: "promo.redeemed",
  promoExhausted: "promo.exhausted",
} as const;
export type PricingTopic = (typeof PRICING_TOPICS)[keyof typeof PRICING_TOPICS];

export type ZoneKind = "SERVICE_AREA" | "NO_PICKUP" | "AIRPORT" | "SURGE";

/** pricing-service → `pricing.rule_scheduled` (key cityId): a fare change was approved for a future time. */
export interface FareRuleScheduledEvent extends EventEnvelope {
  ruleId: string;
  changeRequestId: string;
  cityId: string;
  vehicleType: string;
  /** ISO 8601; equal to approval time for an emergency change */
  validFrom: string;
  baseMinor: number;
  perKmMinor: number;
  perMinMinor: number;
  minFareMinor: number;
  waitingPerMinMinor: number;
  proposedBy: string;
  approvedBy: string;
  emergency: boolean;
}

/** pricing-service → `pricing.rule_activated` (key cityId): new quotes now use this rule. */
export interface FareRuleActivatedEvent extends EventEnvelope {
  ruleId: string;
  cityId: string;
  vehicleType: string;
  validFrom: string;
}

/** pricing-service → `pricing.zone_changed` (key cityId): a zone was created, edited or archived. */
export interface ZoneChangedEvent extends EventEnvelope {
  zoneId: string;
  cityId: string;
  kind: ZoneKind;
  change: "CREATED" | "UPDATED" | "ARCHIVED";
  /** the zone's version after the change (the envelope's `version` is the event schema's) */
  zoneVersion: number;
  byUserId: string;
}

/** pricing-service → `promo.activated` (key promoId). */
export interface PromoActivatedEvent extends EventEnvelope {
  promoId: string;
  code: string;
  cityIds: string[];
  budgetMinor: number;
  startsAt: string;
  endsAt: string;
  fundedBy: string;
  byUserId: string;
}

/**
 * pricing-service → `promo.redeemed` (key tripId), when trip.completed closes a promo reservation.
 * The rider pays `fareMinor − discountMinor`; the driver's earning is unchanged and the difference
 * is promo expense (Payment.md §6.4).
 */
export interface PromoRedeemedEvent extends EventEnvelope {
  promoId: string;
  code: string;
  redemptionId: string;
  tripId: string;
  riderId: string;
  cityId: string;
  quoteId?: string;
  fareMinor: number;
  discountMinor: number;
  currency: string;
  fundedBy: string;
}

/** pricing-service → `promo.exhausted` (key promoId): budget or redemption limit reached; new quotes stop offering it. */
export interface PromoExhaustedEvent extends EventEnvelope {
  promoId: string;
  code: string;
  spentMinor: number;
  budgetMinor: number;
  redemptionCount: number;
}

// ── fleet-service: vehicle ownership and manual suspension (Role.md §6 V9, phase 2D) ──

/** fleet-service → `vehicle.transferred` (key vehicleId): an approved ownership transfer ran (V9). */
export interface VehicleTransferredEvent extends EventEnvelope {
  vehicleId: string;
  transferId: string;
  /** the vehicle's city after the transfer (the new owner's) */
  cityId: string;
  fromOwnerType: "INDIVIDUAL" | "ORGANIZATION";
  fromOwnerId: string;
  toOwnerType: "INDIVIDUAL" | "ORGANIZATION";
  toOwnerId: string;
  /** the owner who asked, when it started from the owner */
  requestedBy: string | null;
  /** the officer who proposed it (maker) and the one who approved it (checker) */
  makerId: string;
  byUserId: string;
}

/** fleet-service → `vehicle.reinstated` (key vehicleId): staff lifted a vehicle suspension. */
export interface VehicleReinstatedEvent extends EventEnvelope {
  vehicleId: string;
  cityId: string;
  reason: string;
  byUserId: string;
}

/** auth-service → `org.reinstated` (key orgId): a partner organisation's suspension was lifted. */
export interface OrgReinstatedEvent extends EventEnvelope {
  orgId: string;
  kind: string;
  cityId: string;
  /** the status restored: VERIFIED, or PENDING when it was suspended while waiting */
  status: "VERIFIED" | "PENDING";
  byUserId: string;
}
