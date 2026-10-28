// Pushes to connected apps through realtime-gateway, without a network hop: Socket.io's Redis
// emitter publishes on the same Redis channel the gateway's adapter listens to. The gateway puts
// every socket in room `user:{userId}`, so we address people, not connections.

import { Emitter } from "@socket.io/redis-emitter";
import type { Redis } from "ioredis";

export interface Realtime {
  toUser(userId: string, event: string, payload: unknown): void;
  /**
   * Every socket of `userId` leaves the trip's live-position room (`trip:{tripId}`), on every
   * gateway pod: a reassigned or released driver stops receiving the car's positions at once.
   */
  leaveTrip?(userId: string, tripId: string): void;
}

export function socketEmitter(redis: Redis): Realtime {
  const emitter = new Emitter(redis);
  return {
    toUser(userId, event, payload) {
      emitter.to(`user:${userId}`).emit(event, payload);
    },
    leaveTrip(userId, tripId) {
      emitter.in(`user:${userId}`).socketsLeave(`trip:${tripId}`);
    },
  };
}

export const noRealtime: Realtime = { toUser: () => undefined };
