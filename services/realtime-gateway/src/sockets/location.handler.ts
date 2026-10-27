import type { Server, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { can, type Principal } from "@ride-app/shared-authz";
import { isTripMember, recordPing, type Ping } from "@ride-app/shared-location";
import type { DriverLocationEvent } from "@ride-app/shared-types";
import type { LocationPublisher } from "../kafka.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** pings closer together than this are dropped (the app sends one every ~4 s) */
const MIN_PING_INTERVAL_MS = 1000;

type Ack = (result: Record<string, unknown>) => void;
const reply = (ack: unknown, result: Record<string, unknown>) => (typeof ack === "function" ? (ack as Ack)(result) : undefined);

export function registerLocationHandlers(io: Server, socket: Socket, deps: { redis: Redis; publisher: LocationPublisher }) {
  const principal = socket.data.principal as Principal;
  let lastPingAt = 0;

  // Driver → every ~4 s (workflow 04, part B). The driver id is the token's subject, never the message.
  socket.on("location:update", async (payload: Partial<Ping> | undefined, ack?: Ack) => {
    if (!can(principal, "location:stream", { ownerUserIds: [principal.userId] })) return reply(ack, { accepted: false, reason: "forbidden" });
    const now = Date.now();
    if (now - lastPingAt < MIN_PING_INTERVAL_MS) return reply(ack, { accepted: false, reason: "too_frequent" });
    const ping: Ping = {
      lat: Number(payload?.lat), lng: Number(payload?.lng),
      heading: payload?.heading === undefined ? undefined : Number(payload.heading),
      speed: payload?.speed === undefined ? undefined : Number(payload.speed),
      accuracy: payload?.accuracy === undefined ? undefined : Number(payload.accuracy),
      at: payload?.at === undefined ? now : Number(payload.at),
    };

    let result;
    try {
      result = await recordPing(deps.redis, principal.userId, ping, now);
    } catch {
      return reply(ack, { accepted: false, reason: "unavailable" });
    }
    if (!result.accepted) return reply(ack, result);
    lastPingAt = now;
    const { state } = result;

    // Fan-out only to the trip location-service assigned this driver to (never a trip id from the client).
    if (state.status === "on_trip" && state.tripId) {
      // speed lets the rider's map move the car smoothly between pings
      io.to(`trip:${state.tripId}`).emit("driver:location", {
        tripId: state.tripId, driverId: principal.userId, lat: ping.lat, lng: ping.lng, heading: ping.heading, speed: ping.speed, at: ping.at,
      });
    }

    // Durable stream for history and ETA. Never awaited on the hot path, never throws.
    const event: DriverLocationEvent = {
      driverId: principal.userId, cityId: state.cityId, lat: ping.lat, lng: ping.lng, at: ping.at,
      ...(state.tripId ? { tripId: state.tripId } : {}),
      ...(ping.heading !== undefined ? { heading: ping.heading } : {}),
      ...(ping.speed !== undefined ? { speed: ping.speed } : {}),
      ...(ping.accuracy !== undefined ? { accuracy: ping.accuracy } : {}),
    };
    deps.publisher.publish(event);
    reply(ack, { accepted: true });
  });

  // Rider (or driver) → watch a trip's live driver position. Only the trip's own rider and driver may join.
  socket.on("trip:subscribe", async (tripId: unknown, ack?: Ack) => {
    if (typeof tripId !== "string" || !UUID.test(tripId)) return reply(ack, { ok: false, reason: "invalid" });
    try {
      if (!(await isTripMember(deps.redis, tripId, principal.userId))) return reply(ack, { ok: false, reason: "not_found" });
    } catch {
      return reply(ack, { ok: false, reason: "unavailable" });
    }
    await socket.join(`trip:${tripId}`);
    reply(ack, { ok: true });
  });

  socket.on("trip:unsubscribe", async (tripId: unknown) => {
    if (typeof tripId === "string") await socket.leave(`trip:${tripId}`);
  });
}
