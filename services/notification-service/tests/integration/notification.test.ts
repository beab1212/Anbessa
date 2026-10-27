import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, phone, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());
beforeEach(async () => {
  // let earlier tests' codes expire and drain their pending fallbacks, so each test starts clean
  h.clock.now += 3600_000;
  await h.c.otp.pollFallbacks();
  h.telegram.calls.length = 0;
  h.telegram.state.sendFails = false;
  h.smsSent.length = 0;
  h.pushes.length = 0;
  h.pushState.fail = false;
});

const otp = (phoneNumber: string, code = "482913") => ({ phoneNumber, code, ttlSeconds: 300, purpose: "sign_in" as const });
const rows = (ids: string[]) => h.c.db.otpDelivery.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } });
const advance = (seconds: number) => (h.clock.now += seconds * 1000);

describe("internal OTP API", () => {
  it("needs the service token and validates input", async () => {
    expect((await h.internal("/internal/otp-deliveries", otp(phone()), "x".repeat(64))).statusCode).toBe(401);
    expect((await h.internal("/internal/otp-deliveries", { ...otp(phone()), phoneNumber: "0911223344" })).statusCode).toBe(400);
    expect((await h.internal("/internal/otp-deliveries", { ...otp(phone()), code: "12ab" })).statusCode).toBe(400);
  });

  it("accepts a code with 202 and the chosen channel", async () => {
    const res = await h.internal("/internal/otp-deliveries", otp(phone()));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ channel: "telegram", deliveryId: expect.any(String) });
  });
});

describe("Telegram first, SMS fallback", () => {
  it("sends our code through Telegram with only the row id as payload", async () => {
    const p = phone();
    const d = await h.c.otp.deliver(otp(p));
    await d.done;
    const send = h.telegram.calls.find((c) => c.method === "sendVerificationMessage")!;
    expect(send.params).toMatchObject({ phone_number: p, code: "482913", ttl: 300, payload: d.deliveryId, request_id: expect.stringMatching(/^req-/) });
    expect(send.params.callback_url).toBe("https://api.anbessa.test/api/webhooks/telegram-gateway");
    const [row] = await rows([d.deliveryId]);
    expect(row).toMatchObject({ channel: "TELEGRAM", status: "SENT", telegramRequestId: send.params.request_id });
    expect(h.smsSent).toEqual([]);
  });

  it("goes straight to SMS when the number can't receive Telegram codes", async () => {
    const p = phone();
    h.telegram.state.unreachable.add(p);
    const d = await h.c.otp.deliver(otp(p, "777111"));
    await d.done;
    expect(h.telegram.calls.map((c) => c.method)).toEqual(["checkSendAbility"]);
    expect(h.smsSent).toEqual([{ to: p, body: expect.stringContaining("777111") }]);
    const all = await h.c.db.otpDelivery.findMany({ where: { OR: [{ id: d.deliveryId }, { fallbackOfId: d.deliveryId }] } });
    expect(all.find((r) => r.id === d.deliveryId)?.status).toBe("NOT_REACHABLE");
    expect(all.find((r) => r.fallbackOfId === d.deliveryId)).toMatchObject({ channel: "SMS", status: "SENT" });
    // the admin system page sees the fallback (the rate used to be null whatever happened)
    const st = await h.c.otp.status();
    expect(st.smsFallbackRate).toBeGreaterThan(0);
  });

  it("falls back to SMS when the Telegram send itself fails", async () => {
    h.telegram.state.sendFails = true;
    const p = phone();
    await (await h.c.otp.deliver(otp(p))).done;
    expect(h.smsSent.map((s) => s.to)).toEqual([p]);
  });

  it("sends the same code by SMS when nothing is delivered within 20 s, and revokes the Telegram message", async () => {
    const p = phone();
    const d = await h.c.otp.deliver(otp(p, "555000"));
    await d.done;
    advance(19);
    await h.c.otp.pollFallbacks();
    expect(h.smsSent).toEqual([]);
    advance(2);
    await h.c.otp.pollFallbacks();
    expect(h.smsSent).toEqual([{ to: p, body: expect.stringContaining("555000") }]);
    expect(h.telegram.calls.some((c) => c.method === "revokeVerificationMessage")).toBe(true);
    await h.c.otp.pollFallbacks(); // claimed once only
    expect(h.smsSent.length).toBe(1);
  });

  it("a signed 'delivered' report cancels the fallback", async () => {
    const d = await h.c.otp.deliver(otp(phone()));
    await d.done;
    const [row] = await rows([d.deliveryId]);
    const res = await h.report({ request_id: row!.telegramRequestId, payload: d.deliveryId, delivery_status: { status: "delivered", updated_at: 1 } });
    expect(res.statusCode).toBe(200);
    expect((await rows([d.deliveryId]))[0]!.status).toBe("DELIVERED");
    advance(30);
    await h.c.otp.pollFallbacks();
    expect(h.smsSent).toEqual([]);
  });

  it("statuses only move forward, and duplicates are harmless", async () => {
    const d = await h.c.otp.deliver(otp(phone()));
    await d.done;
    const id = d.deliveryId;
    await h.report({ payload: id, request_id: "x", delivery_status: { status: "read", updated_at: 2 } });
    await h.report({ payload: id, request_id: "x", delivery_status: { status: "delivered", updated_at: 1 } });
    await h.report({ payload: id, request_id: "x", delivery_status: { status: "expired", updated_at: 3 } });
    expect((await rows([id]))[0]!.status).toBe("READ");
  });

  it("refuses unsigned, tampered and stale reports", async () => {
    const d = await h.c.otp.deliver(otp(phone()));
    await d.done;
    const body = { payload: d.deliveryId, delivery_status: { status: "delivered", updated_at: 1 } };
    expect((await h.report(body, { badSig: true })).statusCode).toBe(401);
    expect((await h.report(body, { tsOffset: -400 })).statusCode).toBe(401);
    const unsigned = await h.app.inject({ method: "POST", url: "/api/webhooks/telegram-gateway", payload: body });
    expect(unsigned.statusCode).toBe(401);
    expect((await rows([d.deliveryId]))[0]!.status).toBe("SENT");
  });

  it("a resend while the Telegram code is still unread goes by SMS directly", async () => {
    const p = phone();
    const first = await h.c.otp.deliver(otp(p, "111111"));
    await first.done;
    const second = await h.c.otp.deliver(otp(p, "222222"));
    await second.done;
    expect(second.channel).toBe("sms");
    expect(h.smsSent).toEqual([{ to: p, body: expect.stringContaining("222222") }]);
    expect((await rows([second.deliveryId]))[0]!.fallbackOfId).toBe(first.deliveryId);
    // the first attempt's fallback must not send the old code later
    advance(30);
    await h.c.otp.pollFallbacks();
    expect(h.smsSent.length).toBe(1);
  });

  it("verified: closes the request on Telegram, marks rows VERIFIED, forgets the code", async () => {
    const p = phone();
    const d = await h.c.otp.deliver(otp(p, "909090"));
    await d.done;
    const res = await h.internal("/internal/otp-deliveries/verified", { phoneNumber: p });
    expect(res.json()).toEqual({ closed: true });
    expect(h.telegram.calls.find((c) => c.method === "checkVerificationStatus")?.params).toMatchObject({ code: "909090" });
    expect((await rows([d.deliveryId]))[0]!.status).toBe("VERIFIED");
    expect(await h.store.getCode(Buffer.from((await rows([d.deliveryId]))[0]!.phoneHash).toString("hex"))).toBeNull();
    advance(30);
    await h.c.otp.pollFallbacks();
    expect(h.smsSent).toEqual([]);
  });

  it("no SMS fallback once the code expired", async () => {
    const d = await h.c.otp.deliver({ ...otp(phone()), ttlSeconds: 60 });
    await d.done;
    advance(61);
    await h.c.otp.pollFallbacks();
    expect(h.smsSent).toEqual([]);
  });

  it("never stores the code or the phone number in Postgres", async () => {
    const p = phone();
    const d = await h.c.otp.deliver(otp(p, "314159"));
    await d.done;
    const dump = JSON.stringify(await h.c.db.$queryRaw`SELECT * FROM otp_delivery`, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    expect(dump).not.toContain("314159");
    expect(dump).not.toContain(p.slice(1));
  });

  it("deletes delivery rows after 30 days", async () => {
    const d = await h.c.otp.deliver(otp(phone()));
    await d.done;
    await h.c.db.otpDelivery.update({ where: { id: d.deliveryId }, data: { createdAt: new Date(Date.now() - 31 * 86_400_000) } });
    expect(await h.c.otp.purgeOld()).toBeGreaterThanOrEqual(1);
    expect(await rows([d.deliveryId])).toEqual([]);
  });
});

describe("devices and event notifications", () => {
  const userId = "0192f7a8-0000-7000-8000-000000000001";

  it("device registration needs a valid app token", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/notifications/devices", payload: { token: "t".repeat(40), platform: "android" } });
    expect(res.statusCode).toBe(401);
    const bad = await h.app.inject({
      method: "POST", url: "/api/notifications/devices", payload: { token: "t".repeat(40), platform: "android" },
      headers: { authorization: "Bearer not.a.token" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("org.member_invited → one SMS, even when the event is delivered twice", async () => {
    const p = phone();
    const event = { eventId: crypto.randomUUID(), version: 1, at: new Date().toISOString(), invitationId: "i1", orgId: "o1", orgName: "Abebe Transport PLC", role: "fleet_driver", phoneNumber: p };
    await h.c.handlers["org.member_invited"]!(event);
    await h.c.handlers["org.member_invited"]!(event);
    expect(h.smsSent).toEqual([{ to: p, body: expect.stringContaining("Abebe Transport PLC invites you to drive") }]);
  });

  it("role.granted DRIVER → push to the user's devices; skipped without devices", async () => {
    const e = (id = crypto.randomUUID()) => ({ eventId: id, version: 1, at: "", userId, role: "DRIVER", byUserId: null });
    await h.c.handlers["role.granted"]!(e());
    expect(h.pushes).toEqual([]);

    const token = await h.appToken(userId);
    const reg = await h.app.inject({
      method: "POST", url: "/api/notifications/devices", payload: { token: "device-token-".padEnd(40, "x"), platform: "android" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reg.statusCode).toBe(204);
    await h.c.handlers["role.granted"]!(e());
    expect(h.pushes).toEqual([{ token: "device-token-".padEnd(40, "x"), message: expect.objectContaining({ title: "You're approved to drive" }) }]);
    await h.c.handlers["role.granted"]!({ ...e(), role: "RIDER" });
    expect(h.pushes.length).toBe(1);
  });

  it("payments: the rider is asked to approve and gets a receipt; owner-drivers hear about their balance, fleets don't", async () => {
    const rider = "0192f7a8-0000-7000-8000-0000000000a1";
    const driver = "0192f7a8-0000-7000-8000-0000000000a2";
    for (const [user, token] of [[rider, "rider-device".padEnd(40, "r")], [driver, "driver-device".padEnd(40, "d")]] as const) {
      await h.c.db.deviceToken.upsert({ where: { token }, create: { token, platform: "android", userId: user }, update: {} });
    }
    const env = () => ({ eventId: crypto.randomUUID(), version: 1, at: new Date().toISOString() });
    const before = h.pushes.length;
    await h.c.handlers["payment.action_required"]!({ ...env(), riderId: rider, tripId: "t1", amountMinor: 40_000, provider: "telebirr", purpose: "TRIP_FARE", checkoutUrl: "http://pay/x" });
    await h.c.handlers["trip.settled"]!({ ...env(), riderId: rider, tripId: "t1", fareMinor: 40_000, paymentMethod: "CASH", purpose: "TRIP_FARE" });
    await h.c.handlers["balance.state_changed"]!({ ...env(), beneficiary: { type: "INDIVIDUAL", id: driver }, state: "CASH_BLOCKED", balanceMinor: -52_000 });
    await h.c.handlers["balance.state_changed"]!({ ...env(), beneficiary: { type: "ORGANIZATION", id: driver }, state: "BLOCKED", balanceMinor: -200_000 });
    const sent = h.pushes.slice(before).map((p) => p.message.body);
    expect(sent).toEqual([
      "Approve 400 ETB to Anbessa in telebirr.",
      "400 ETB paid by cash. Thanks for riding with Anbessa.",
      "You owe 520 ETB. Cash trips are paused; card and mobile money trips continue and repay it.",
    ]);
    // a tap opens the trip's pay screen in the phone app
    expect(h.pushes[before]!.message.data).toEqual({ type: "payment.action_required", tripId: "t1", checkoutUrl: "http://pay/x" });
  });

  it("a failing push is retried through redelivery, then recorded as FAILED", async () => {
    await h.c.db.deviceToken.upsert({ where: { token: "retry-token".padEnd(40, "r") }, create: { token: "retry-token".padEnd(40, "r"), platform: "ios", userId }, update: {} });
    h.pushState.fail = true;
    const event = { eventId: crypto.randomUUID(), version: 1, at: "", userId, role: "DRIVER" };
    for (let i = 0; i < 4; i++) await expect(h.c.handlers["role.granted"]!(event)).rejects.toThrow();
    await expect(h.c.handlers["role.granted"]!(event)).resolves.toBe("FAILED");
    const row = await h.c.db.notification.findUniqueOrThrow({ where: { dedupeKey: `${event.eventId}:PUSH` } });
    expect(row).toMatchObject({ status: "FAILED", attempts: 5 });
  });

  it("dead device tokens are removed", async () => {
    const dead = "dead-token".padEnd(40, "d");
    const other = "0192f7a8-0000-7000-8000-000000000002";
    await h.c.db.deviceToken.create({ data: { token: dead, platform: "android", userId: other } });
    h.pushState.unregistered.add(dead);
    await h.c.handlers["role.granted"]!({ eventId: crypto.randomUUID(), version: 1, at: "", userId: other, role: "DRIVER" });
    expect(await h.c.db.deviceToken.findUnique({ where: { token: dead } })).toBeNull();
  });

  it("users can only remove their own device tokens", async () => {
    const owner = "0192f7a8-0000-7000-8000-000000000003";
    const token = "owned-token".padEnd(40, "o");
    await h.c.db.deviceToken.create({ data: { token, platform: "android", userId: owner } });
    const res = await h.app.inject({
      method: "POST", url: "/api/notifications/devices/remove", payload: { token },
      headers: { authorization: `Bearer ${await h.appToken("0192f7a8-0000-7000-8000-000000000004")}` },
    });
    expect(res.statusCode).toBe(204);
    expect(await h.c.db.deviceToken.findUnique({ where: { token } })).not.toBeNull();
  });
});
