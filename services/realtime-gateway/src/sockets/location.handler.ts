import type { Server, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { can, type Principal } from "@ride-app/shared-authz";
import { isTripMember, keys, recordPing, type Ping } from "@ride-app/shared-location";
import type { DriverLocationEvent } from "@ride-app/shared-types";
import type { LocationPublisher } from "../kafka.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** pings closer together than this are dropped (the app sends one every ~4 s) */
const MIN_PING_INTERVAL_MS = 1000;

/** how often each gateway pod re-checks who sits in its trip rooms */
export const TRIP_ROOM_SWEEP_MS = 15_000;

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

/**
 * Backstop for trip-room membership: `trip:subscribe` checks `trip:{id}:members` once, and
 * trip-service makes a reassigned or cancelled driver leave the room at once (Redis emitter,
 * socketsLeave). This re-checks every socket in this pod's trip rooms against the members set
 * (one pipelined SISMEMBER each) and removes whoever is no longer on the trip, e.g. after a missed
 * leave or once the members set expired after the trip ended. A Redis error leaves everyone in place.
 * Returns how many sockets left.
 */
export async function sweepTripRooms(io: Server, redis: Redis): Promise<number> {
  const nsp = io.of("/");
  const checks: { socket: Socket; tripId: string; userId: string }[] = [];
  for (const [room, socketIds] of nsp.adapter.rooms) {
    if (!room.startsWith("trip:")) continue;
    const tripId = room.slice("trip:".length);
    if (!UUID.test(tripId)) continue;
    for (const id of socketIds) {
      const socket = nsp.sockets.get(id);
      const userId = socket?.data.userId as string | undefined;
      if (socket && userId) checks.push({ socket, tripId, userId });
    }
  }
  if (checks.length === 0) return 0;
  const p = redis.pipeline();
  for (const c of checks) p.sismember(keys.tripMembers(c.tripId), c.userId);
  let res: [Error | null, unknown][] | null;
  try {
    res = await p.exec();
  } catch {
    return 0;
  }
  let removed = 0;
  for (const [i, c] of checks.entries()) {
    const [err, member] = res?.[i] ?? [null, 1];
    if (err || member !== 0) continue;
    await c.socket.leave(`trip:${c.tripId}`);
    removed++;
  }
  return removed;
}
