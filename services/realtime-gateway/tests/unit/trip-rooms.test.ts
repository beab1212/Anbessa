import { describe, expect, it } from "vitest";
import { sweepTripRooms } from "../../src/sockets/location.handler.js";

const TRIP = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

// a socket.io namespace's local view (adapter.rooms, sockets) and a Redis with trip members sets
function setup(members: Record<string, string[]>, opts: { redisDown?: boolean } = {}) {
  const rooms = new Map<string, Set<string>>();
  const sockets = new Map<string, { data: { userId: string }; leave: (room: string) => Promise<void> }>();
  const add = (socketId: string, userId: string, room: string) => {
    if (!sockets.has(socketId)) {
      sockets.set(socketId, {
        data: { userId },
        leave: async (r) => void rooms.get(r)?.delete(socketId),
      });
    }
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room)!.add(socketId);
  };
  const io = { of: () => ({ adapter: { rooms }, sockets }) };
  const redis = {
    pipeline() {
      const calls: [string, string][] = [];
      const p = {
        sismember: (key: string, userId: string) => (calls.push([key, userId]), p),
        exec: async () => {
          if (opts.redisDown) throw new Error("redis down");
          return calls.map(([key, userId]) => {
            const tripId = key.split(":")[1]!;
            return [null, (members[tripId] ?? []).includes(userId) ? 1 : 0];
          });
        },
      };
      return p;
    },
  };
  return { io: io as never, redis: redis as never, rooms, add };
}

describe("sweepTripRooms (who still receives a trip's live positions)", () => {
  it("removes a reassigned driver and keeps the rider and the new driver", async () => {
    const s = setup({ [TRIP]: ["rider", "new-driver"] });
    s.add("s1", "rider", `trip:${TRIP}`);
    s.add("s2", "old-driver", `trip:${TRIP}`);
    s.add("s3", "new-driver", `trip:${TRIP}`);
    s.add("s2", "old-driver", "user:old-driver");
    expect(await sweepTripRooms(s.io, s.redis)).toBe(1);
    expect([...s.rooms.get(`trip:${TRIP}`)!]).toEqual(["s1", "s3"]);
    // other rooms are untouched
    expect(s.rooms.get("user:old-driver")?.has("s2")).toBe(true);
  });

  it("empties the room once the trip's members set is gone (trip over)", async () => {
    const s = setup({});
    s.add("s1", "rider", `trip:${OTHER}`);
    expect(await sweepTripRooms(s.io, s.redis)).toBe(1);
    expect(s.rooms.get(`trip:${OTHER}`)?.size).toBe(0);
  });

  it("leaves everyone in place when Redis can't be read", async () => {
    const s = setup({}, { redisDown: true });
    s.add("s1", "rider", `trip:${TRIP}`);
    expect(await sweepTripRooms(s.io, s.redis)).toBe(0);
    expect(s.rooms.get(`trip:${TRIP}`)?.has("s1")).toBe(true);
  });
});
