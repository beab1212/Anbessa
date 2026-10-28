import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { createCampaignService } from "../../src/campaigns/service.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const uuid = () => crypto.randomUUID();
const DAY = 24 * 3_600_000;
// 12:00 and 22:00 in Addis Ababa (UTC+3)
const NOON = Date.UTC(2026, 10, 2, 9, 0);
const NIGHT = Date.UTC(2026, 10, 2, 19, 0);

const staff = async (roles: object[]) => {
  const id = uuid();
  return { id, token: await h.staffToken(id, roles) };
};
const marketing = (city = "addis-ababa") => staff([{ r: "MARKETING", city }]);
const call = (method: "GET" | "POST" | "PUT", url: string, who: { token: string } | null, payload?: object, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, payload, headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers } });
const event = (topic: string, body: object) => h.c.handlers[topic]!({ eventId: uuid(), version: 1, at: new Date(h.clock.now).toISOString(), ...body });

/** A rider (or driver) seen in a city `daysAgo`, with or without a phone app registered. */
async function person(role: "RIDER" | "DRIVER", opts: { cityId?: string; daysAgo?: number; device?: boolean; phone?: string } = {}) {
  const id = uuid();
  const at = new Date(h.clock.now - (opts.daysAgo ?? 0) * DAY).toISOString();
  if (role === "RIDER") await event("trip.requested", { tripId: uuid(), riderId: id, cityId: opts.cityId ?? "addis-ababa", at });
  else await event("driver.online", { driverId: id, cityId: opts.cityId ?? "addis-ababa", vehicleId: uuid(), vehicleType: "economy", at });
  if (opts.device) await h.c.db.deviceToken.create({ data: { userId: id, token: `fcm-${id}-0123456789abcdef`, platform: "android" } });
  if (opts.phone) h.phones.set(id, opts.phone);
  return id;
}

async function drain(intervalMs = 1000, max = 20) {
  for (let i = 0; i < max; i++) {
    const r = await h.c.campaigns.tick(intervalMs);
    if (!r.started && !r.sent && !r.finished && !r.failed) {
      const left = await h.c.db.campaignDelivery.count({ where: { status: { in: ["PENDING", "IN_FLIGHT"] } } });
      if (!left) return;
    }
  }
}

describe("campaigns", () => {
  it("the audience comes from trip and driver events, keeping the latest activity", async () => {
    h.clock.now = NOON;
    const rider = uuid();
    const driver = uuid();
    await event("trip.completed", { tripId: uuid(), riderId: rider, driverId: driver, cityId: "hawassa", completedAt: new Date(NOON - DAY).toISOString() });
    await event("trip.requested", { tripId: uuid(), riderId: rider, cityId: "hawassa", at: new Date(NOON - 3 * DAY).toISOString() });
    const rows = await h.c.db.campaignAudience.findMany({ where: { userId: { in: [rider, driver] } }, orderBy: { role: "asc" } });
    expect(rows.map((r) => [r.role, r.cityId, r.lastActiveAt.getTime()])).toEqual([["DRIVER", "hawassa", NOON - DAY], ["RIDER", "hawassa", NOON - DAY]].sort());
    // malformed ids are ignored
    await expect(event("trip.requested", { riderId: "nope", cityId: "hawassa" })).resolves.toBeUndefined();
  });

  it("marketing sends a push to riders of their city: opt-outs, quiet hours, devices, counts, audit", async () => {
    h.clock.now = NIGHT;
    const withPhone = await person("RIDER", { device: true });
    const noDevice = await person("RIDER");
    const optedOut = await person("RIDER", { device: true });
    const elsewhere = await person("RIDER", { cityId: "hawassa", device: true });
    const appUser = { token: await h.appToken(optedOut) };
    expect((await call("PUT", "/api/notifications/me/marketing", appUser, { push: false })).json()).toEqual({ push: false, sms: true });

    const mk = await marketing();
    expect((await call("GET", "/api/notifications/campaigns", { token: await h.appToken(uuid()) })).statusCode).toBe(401);
    expect((await call("GET", "/api/notifications/campaigns", await staff([{ r: "DISPATCHER", city: "addis-ababa" }]))).statusCode).toBe(403);
    expect((await call("POST", "/api/notifications/campaigns", await marketing("hawassa"), { cityId: "addis-ababa", audience: "RIDER", channel: "PUSH", title: "x", body: "y" })).statusCode).toBe(403);
    expect((await call("POST", "/api/notifications/campaigns", mk, { cityId: "addis-ababa", audience: "RIDER", channel: "PUSH", body: "no title" })).json()).toMatchObject({ error: "title_required" });

    const key = { "idempotency-key": `camp-${uuid()}` };
    const body = { cityId: "addis-ababa", audience: "RIDER", channel: "PUSH", title: "Meskel weekend", body: "20% off with MESKEL20" };
    const a = await call("POST", "/api/notifications/campaigns", mk, body, key);
    const b = await call("POST", "/api/notifications/campaigns", mk, body, key);
    expect(a.statusCode, a.body).toBe(201);
    expect(b.json<Json>().campaign.id).toBe(a.json<Json>().campaign.id);
    const id = a.json<Json>().campaign.id;
    expect((await call("GET", `/api/notifications/campaigns/${id}`, await marketing("hawassa"))).statusCode).toBe(404);

    const size = (await call("GET", "/api/notifications/campaigns/audience?cityId=addis-ababa&audience=RIDER&channel=PUSH", mk)).json<Json>().count;
    expect(size).toBeGreaterThanOrEqual(2);
    expect((await call("GET", `/api/notifications/campaigns/${id}`, mk)).json<Json>().campaign).toMatchObject({ status: "DRAFT", audienceEstimate: size, quietNow: true });

    expect((await call("POST", `/api/notifications/campaigns/${id}/schedule`, mk, {})).json<Json>().campaign.status).toBe("SCHEDULED");
    expect((await call("PUT", `/api/notifications/campaigns/${id}`, mk, body)).json()).toMatchObject({ error: "not_draft" });

    // 22:00: recipients are fixed, nothing is sent
    await h.c.campaigns.tick();
    let c = (await call("GET", `/api/notifications/campaigns/${id}`, mk)).json<Json>().campaign;
    expect(c).toMatchObject({ status: "SENDING", targeted: size });
    expect(c.counts.sent).toBe(0);
    const recipients = (await h.c.db.campaignDelivery.findMany({ where: { campaignId: id } })).map((d) => d.userId);
    expect(recipients).toEqual(expect.arrayContaining([withPhone, noDevice]));
    expect(recipients).not.toContain(optedOut);
    expect(recipients).not.toContain(elsewhere);

    // 08:00 next morning
    h.clock.now = NOON + DAY;
    await drain();
    c = (await call("GET", `/api/notifications/campaigns/${id}`, mk)).json<Json>().campaign;
    expect(c.status).toBe("SENT");
    expect(c.counts.pending).toBe(0);
    expect(c.counts.sent + c.counts.skipped + c.counts.failed).toBe(size);
    expect(h.pushes.some((p) => p.token === `fcm-${withPhone}-0123456789abcdef` && p.message.title === "Meskel weekend" && p.message.data?.campaignId === id)).toBe(true);
    expect(h.pushes.some((p) => p.token.includes(optedOut) || p.token.includes(elsewhere))).toBe(false);
    expect((await h.c.db.campaignDelivery.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: id, userId: noDevice } } }))).toMatchObject({ status: "SKIPPED", error: "no_device" });
    const audit = (await h.c.db.outbox.findMany({ where: { topic: "audit.recorded" } })).map((r) => r.payload as Json);
    expect(audit.some((e) => e.action === "campaign:send" && e.resource.id === id && e.service === "notification-service")).toBe(true);
    expect((await call("GET", "/api/notifications/campaigns?cityId=addis-ababa", mk)).json<Json>().campaigns.map((x: Json) => x.id)).toContain(id);
    expect((await call("GET", "/api/notifications/campaigns", await marketing("hawassa"))).json<Json>().campaigns.map((x: Json) => x.id)).not.toContain(id);
  });

  it("SMS to recently active drivers: rate-limited batches, phones from auth-service, retries then FAILED", async () => {
    h.clock.now = NOON + 2 * DAY;
    const city = "hawassa";
    const drivers = await Promise.all([0, 1, 2, 3, 4].map((i) => person("DRIVER", { cityId: city, phone: `+2519110000${i}0` })));
    const noPhone = await person("DRIVER", { cityId: city });
    const inactive = await person("DRIVER", { cityId: city, daysAgo: 40, phone: "+251911999999" });
    const mk = await marketing(city);
    const id = (await call("POST", "/api/notifications/campaigns", mk, { cityId: city, audience: "DRIVER", channel: "SMS", lastActiveDays: 30, body: "New fares from Monday" })).json<Json>().campaign.id;
    await call("POST", `/api/notifications/campaigns/${id}/schedule`, mk, {});

    const before = h.smsSent.length;
    await h.c.campaigns.tick(100); // 20/s × 0.1 s = 2 per tick
    expect(h.smsSent.length - before).toBeLessThanOrEqual(2);
    await drain(100, 50);
    const sent = h.smsSent.slice(before);
    expect(sent.every((m) => m.body === "Anbessa: New fares from Monday")).toBe(true);
    expect(new Set(sent.map((m) => m.to))).toEqual(new Set(drivers.map((_, i) => `+2519110000${i}0`)));
    const rows = await h.c.db.campaignDelivery.findMany({ where: { campaignId: id } });
    expect(rows.find((r) => r.userId === noPhone)).toMatchObject({ status: "SKIPPED", error: "no_phone" });
    expect(rows.some((r) => r.userId === inactive)).toBe(false);

    // push provider down: three attempts, then FAILED; the campaign still finishes
    const rider = await person("RIDER", { cityId: city, device: true });
    const pushId = (await call("POST", "/api/notifications/campaigns", mk, { cityId: city, audience: "RIDER", channel: "PUSH", title: "Hi", body: "Hello" })).json<Json>().campaign.id;
    await call("POST", `/api/notifications/campaigns/${pushId}/schedule`, mk, {});
    h.pushState.fail = true;
    try {
      await drain(1000, 10);
    } finally {
      h.pushState.fail = false;
    }
    expect(await h.c.db.campaignDelivery.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: pushId, userId: rider } } })).toMatchObject({ status: "FAILED", attempts: 3 });
    // (other Hawassa riders with a phone app, from the tests above, fail the same way)
    const done = (await call("GET", `/api/notifications/campaigns/${pushId}`, mk)).json<Json>().campaign;
    expect(done.status).toBe("SENT");
    expect(done.counts.failed).toBeGreaterThanOrEqual(1);
    expect(done.counts.sent).toBe(0);
  });

  it("scheduled for later, then cancelled: nothing goes out", async () => {
    h.clock.now = NOON + 3 * DAY;
    await person("RIDER", { device: true });
    const mk = await marketing();
    const id = (await call("POST", "/api/notifications/campaigns", mk, { cityId: "addis-ababa", audience: "RIDER", channel: "PUSH", title: "Later", body: "Soon" })).json<Json>().campaign.id;
    expect((await call("POST", `/api/notifications/campaigns/${id}/schedule`, mk, { at: new Date(h.clock.now - DAY).toISOString() })).json()).toMatchObject({ error: "in_past" });
    await call("POST", `/api/notifications/campaigns/${id}/schedule`, mk, { at: new Date(h.clock.now + 3_600_000).toISOString() });
    await h.c.campaigns.tick();
    expect((await h.c.db.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("SCHEDULED");
    expect((await call("POST", `/api/notifications/campaigns/${id}/cancel`, mk, {})).json<Json>().campaign.status).toBe("CANCELLED");
    h.clock.now += 2 * 3_600_000;
    const pushes = h.pushes.length;
    await h.c.campaigns.tick();
    expect(h.pushes.length).toBe(pushes);
    expect((await call("POST", `/api/notifications/campaigns/${id}/cancel`, mk, {})).json()).toMatchObject({ error: "invalid_transition" });
  });

  it("a large campaign needs a second staff member's approval (maker-checker)", async () => {
    h.clock.now = NOON + 4 * DAY;
    const city = "bahir-dar";
    await Promise.all([0, 1, 2].map(() => person("RIDER", { cityId: city, device: true })));
    // same database, a threshold of 2 recipients
    const svc = createCampaignService({
      db: h.c.db, push: { send: async () => "sent" }, sms: { send: async () => ({}) }, contacts: { phoneOf: async () => null },
      logger: pino({ level: "silent" }), now: h.now, sendPerSecond: 100, quietHours: { from: 0, to: 0 }, approvalThreshold: 2,
    });
    const principal = async () => { const s = await marketing(city); return { id: s.id, p: await h.verifyAccessToken(s.token, "ride-admin") }; };
    const maker = await principal();
    const checker = await principal();
    const c = await svc.create(maker.p, { cityId: city, audience: "RIDER", channel: "PUSH", title: "Big", body: "Everyone" });
    expect((await svc.schedule(maker.p, c.id)).status).toBe("AWAITING_APPROVAL");
    await svc.tick();
    expect((await h.c.db.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("AWAITING_APPROVAL");
    await expect(svc.approve(maker.p, c.id)).rejects.toMatchObject({ statusCode: 403, code: "second_approver_required" });
    const approved = await svc.approve(checker.p, c.id);
    expect(approved).toMatchObject({ status: "SCHEDULED", approvedBy: checker.id });
    await expect(svc.approve(checker.p, c.id)).rejects.toMatchObject({ code: "invalid_transition" });
    await svc.tick();
    expect((await h.c.db.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toMatch(/SENDING|SENT/);

    // under the threshold: no approval step
    const small = await svc.create(maker.p, { cityId: city, audience: "DRIVER", channel: "PUSH", title: "Small", body: "Few" });
    expect((await svc.schedule(maker.p, small.id)).status).toBe("SCHEDULED");
  });
});
