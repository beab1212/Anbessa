// Pushes to the phone app through realtime-gateway, without a network hop: Socket.io's Redis
// emitter publishes on the channel the gateway's adapter listens to; every socket of a user is in
// room `user:{userId}`. Best effort. Staff consoles can't connect (the gateway admits only
// ride-app tokens), so they poll.

import { Emitter } from "@socket.io/redis-emitter";
import type { Redis } from "ioredis";

export interface Realtime {
  toUser(userId: string, event: string, payload: unknown): void;
}

export function socketEmitter(redis: Redis): Realtime {
  const emitter = new Emitter(redis);
  return {
    toUser(userId, event, payload) {
      emitter.to(`user:${userId}`).emit(event, payload);
    },
  };
}

export const noRealtime: Realtime = { toUser: () => undefined };
