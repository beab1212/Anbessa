// The trip as trip-service's API returns it (GET /api/trips/:id, socket trip:status).
// Mirrored in packages/core/lib/models/trip.dart: change both in the same PR.

export type TripStatus =
  | "requested"
  | "matched"
  | "en_route"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface TripPlace {
  lat: number;
  lng: number;
  address: string | null;
}

export interface Trip {
  id: string;
  status: TripStatus;
  cityId: string;
  channel: "APP" | "PHONE" | "CORPORATE_PORTAL";
  vehicleType: string;
  paymentMethod: "CASH" | "MOBILE_MONEY" | "CARD" | "CORPORATE";
  billing: { type: "PERSONAL" | "CORPORATE"; orgId: string | null };
  riderUserId: string;
  pickup: TripPlace;
  dropoff: TripPlace;
  driver: { userId: string; vehicleId: string | null } | null;
  /** minor units (santim) */
  fare: { estimateMinor: number; finalMinor: number | null; waitingFeeMinor: number | null; currency: string };
  route: { estDistanceMeters: number; estDurationSeconds: number; distanceMeters: number | null; durationSeconds: number | null };
  /** ISO 8601 */
  times: {
    requestedAt: string; matchedAt: string | null; arrivedAt: string | null;
    startedAt: string | null; completedAt: string | null; cancelledAt: string | null;
  };
  cancellation: { by: "RIDER" | "DRIVER" | "SYSTEM" | "STAFF"; reason: string; feeMinor: number; driverCompensationMinor: number } | null;
  /** only to the rider and whoever booked the trip: the driver asks for it at pickup */
  pin?: string;
  /** staff only: review flags such as FAR_FROM_DROPOFF */
  flags?: string[];
}
