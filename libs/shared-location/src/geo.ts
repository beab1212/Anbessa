export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Redis GEO accepts latitudes within ±85.05112878 only. */
export function isValidLatLng(p: { lat: unknown; lng: unknown }): p is LatLng {
  return (
    typeof p.lat === "number" && typeof p.lng === "number" &&
    Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 85.05112878 && Math.abs(p.lng) <= 180
  );
}

export interface Ping extends LatLng {
  heading?: number;
  speed?: number;
  /** GPS accuracy radius in meters */
  accuracy?: number;
  /** device time, unix ms */
  at: number;
}

export type PingRejection = "invalid" | "inaccurate" | "future" | "out_of_order" | "too_fast";

export const PING_LIMITS = {
  maxAccuracyMeters: 100,
  maxSpeedMps: 200 / 3.6, // 200 km/h between two pings
  maxClockSkewMs: 5_000,
};

/**
 * Workflow 04, step 9: drop implausible pings before they reach the geo index.
 * `previous` is the last accepted ping for this driver.
 */
export function checkPing(ping: Ping, previous: { lat: number; lng: number; at: number } | undefined, now: number): PingRejection | undefined {
  if (!isValidLatLng(ping) || !Number.isFinite(ping.at)) return "invalid";
  if (ping.accuracy !== undefined && ping.accuracy > PING_LIMITS.maxAccuracyMeters) return "inaccurate";
  if (ping.at > now + PING_LIMITS.maxClockSkewMs) return "future";
  if (previous) {
    if (ping.at <= previous.at) return "out_of_order";
    const seconds = (ping.at - previous.at) / 1000;
    if (haversineMeters(previous, ping) / seconds > PING_LIMITS.maxSpeedMps) return "too_fast";
  }
  return undefined;
}
