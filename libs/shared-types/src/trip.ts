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
  fare: {
    estimateMinor: number;
    finalMinor: number | null;
    waitingFeeMinor: number | null;
    currency: string;
    /** promo discount taken off what the rider pays (the driver is paid on the full fare) */
    promoDiscountMinor?: number;
    promoCode?: string | null;
    /** what the rider pays: final (or estimate) minus the discount */
    payableMinor?: number;
  };
  route: {
    estDistanceMeters: number;
    estDurationSeconds: number;
    distanceMeters: number | null;
    durationSeconds: number | null;
    /** the road line pickup → drop-off, encoded polyline precision 6 (null for trips quoted before it existed) */
    polyline: string | null;
  };
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

/** What a rider or driver can tick when rating (workflow 08 step 14). The apps localise them. */
export const RATING_TAGS = {
  RIDER: ["polite", "safe_driving", "clean_car", "on_time", "good_navigation", "rude", "unsafe_driving", "dirty_car", "late", "took_long_route"],
  DRIVER: ["polite", "on_time", "clear_pickup", "respectful", "rude", "late", "wrong_pickup", "left_mess"],
} as const;
