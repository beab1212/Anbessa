import type { Server, Socket } from "socket.io";
import { Redis } from "ioredis";
import { Kafka } from "kafkajs";
import { config } from "../config/index.js";

const redis = new Redis(config.REDIS_URL);
const kafka = new Kafka({ clientId: "realtime-gateway", brokers: config.KAFKA_BROKERS.split(",") });
const producer = kafka.producer();

interface LocationUpdate {
  tripId: string;
  lat: number;
  lng: number;
  heading?: number;
}

export function registerLocationHandlers(io: Server, socket: Socket) {
  socket.on("location:update", async (payload: LocationUpdate) => {
    const driverId = socket.data.userId as string;

    // 1. Fast path: live position for "nearby drivers" queries, TTL so a dropped
    //    connection naturally disappears instead of leaving a stale ghost pin.
    await redis.geoadd("drivers:geo", payload.lng, payload.lat, driverId);
    await redis.expire("drivers:geo", 15);

    // 2. Fan-out: push to whoever is subscribed to this trip's room. Socket.io's
    //    Redis adapter handles cross-instance delivery, so it doesn't matter which
    //    gateway pod holds the rider's socket.
    io.to(`trip:${payload.tripId}`).emit("driver:location", { driverId, ...payload });

    // 3. Durable path: downstream consumers (ETA recalculation, trip audit,
    //    analytics) read from Kafka, never from this hot path directly.
    await producer.send({
      topic: "driver.location",
      messages: [{ key: driverId, value: JSON.stringify({ driverId, ...payload, at: Date.now() }) }],
    });
  });
}
