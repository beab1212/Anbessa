// Pushes to connected apps through realtime-gateway, without a network hop: Socket.io's Redis
// emitter publishes on the same Redis channel the gateway's adapter listens to. The gateway puts
// every socket in room `user:{userId}`, so we address people, not connections.

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
