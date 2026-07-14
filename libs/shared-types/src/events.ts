// Kafka event payload contracts. Keeping these in one shared package means a
// producer and consumer in two different services can't silently drift apart.
export interface DriverLocationEvent {
  driverId: string;
  tripId: string;
  lat: number;
  lng: number;
  at: number;
}

export interface UserCreatedEvent {
  userId: string;
  role: string;
  at: string;
}
