// Redis key layout for live location (docs/design/Database.md §10).
// City keys use a hash tag ({city}) so one city's sets share a cluster slot.

const CITY = /^[a-z0-9-]{1,40}$/;
const VEHICLE_TYPE = /^[a-z0-9_]{1,30}$/;

export function assertCity(cityId: string): string {
  if (!CITY.test(cityId)) throw new Error(`invalid city id: ${cityId}`);
  return cityId;
}

export function assertVehicleType(vehicleType: string): string {
  if (!VEHICLE_TYPE.test(vehicleType)) throw new Error(`invalid vehicle type: ${vehicleType}`);
  return vehicleType;
}

export type GeoSet = "available" | "busy";

export const keys = {
  /** GEO set of online drivers, split by city, vehicle type and whether they're free */
  geo: (cityId: string, vehicleType: string, set: GeoSet) => `geo:{${assertCity(cityId)}}:${assertVehicleType(vehicleType)}:${set}`,
  /** sorted set: driverId → last ping (unix ms) */
  seen: (cityId: string) => `seen:{${assertCity(cityId)}}`,
  /** vehicle types that have had drivers in this city (so the sweeper can clean every set) */
  vehicleTypes: (cityId: string) => `vtypes:{${assertCity(cityId)}}`,
  /** cities with online drivers (the sweeper iterates these) */
  cities: () => "location:cities",
  /** hash: the driver's live state */
  driver: (driverId: string) => `driver:${driverId}`,
  /** soft lock: the trip currently offered to the driver (written by trip-service) */
  offer: (driverId: string) => `offer:driver:${driverId}`,
  /** hash: last known driver position for the rider screen */
  tripLast: (tripId: string) => `trip:${tripId}:last`,
  /** set: the rider and driver of a trip (who may watch its live location) */
  tripMembers: (tripId: string) => `trip:${tripId}:members`,
  /** sweeper lock, one instance per city */
  sweepLock: (cityId: string) => `lock:sweep:{${assertCity(cityId)}}`,
};
