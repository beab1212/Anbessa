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
  balanceState?: "OK" | "WARNING" | "CASH_BLOCKED" | "BLOCKED";
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
  /** final fare in minor units (santim), waiting fee included */
  fareMinor: number;
  waitingFeeMinor: number;
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
  currency: string;
}

/** auth-service → `user.created` (key userId). */
export interface UserCreatedEvent extends EventEnvelope {
  userId: string;
  /** created by the call center (phone only, not yet claimed) */
  guest: boolean;
}
