export type TripStatus =
  | "requested"
  | "matched"
  | "en_route"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface Trip {
  id: string;
  riderId: string;
  driverId: string | null;
  status: TripStatus;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  fareEstimateCents: number;
  createdAt: string;
}
