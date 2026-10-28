import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConsumer } from "../../src/events/consumer.js";
import { createHarness, TOKEN, uuid, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const support = (cityId = "addis-ababa") => h.staff([{ r: "SUPPORT_AGENT", city: cityId }]);
const safety = (cityId = "addis-ababa") => h.staff([{ r: "SAFETY_OFFICER", city: cityId }]);
const dispatcher = (cityId = "addis-ababa") => h.staff([{ r: "DISPATCHER", city: cityId }]);

describe("tickets", () => {
  it("a rider opens a ticket on their trip: the trip's city, the category's SLA, ticket.created; others can't see it", async () => {
    const rider = await h.appUser();
    const t = h.trip({ riderUserId: rider.id, cityId: "hawassa" });
    const res = await h.req("POST", "/api/support/tickets", rider, { category: "TRIP", subject: "Wrong route", description: "The driver went the long way", tripId: t.id });
    expect(res.statusCode, res.body).toBe(201);
    const ticket = res.json<Json>().ticket;
    expect(ticket).toMatchObject({ cityId: "hawassa", category: "TRIP", status: "OPEN", tripId: t.id });
    expect(ticket).not.toHaveProperty("assigneeUserId");
    expect(new Date(ticket.createdAt).getTime() + 8 * HOUR).toBe(new Date((await h.c.db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).firstResponseDueAt).getTime());
    expect((await h.outbox("ticket.created")).some((e) => e.ticketId === ticket.id && e.priority === "P3")).toBe(true);

    const stranger = await h.appUser();
    expect((await h.req("POST", "/api/support/tickets", stranger, { category: "TRIP", subject: "x", description: "y", tripId: t.id })).statusCode).toBe(404);
    expect((await h.req("GET", `/api/support/tickets/${ticket.id}`, stranger)).statusCode).toBe(404);
    expect((await h.req("GET", `/api/support/tickets/${ticket.id}`, await support("addis-ababa"))).statusCode).toBe(404);
    expect((await h.req("GET", `/api/support/tickets/${ticket.id}`, await support("hawassa"))).statusCode).toBe(200);
    expect((await h.req("GET", "/api/support/tickets?cityId=hawassa", await support("addis-ababa"))).statusCode).toBe(403);
    expect((await h.req("GET", "/api/support/tickets", rider)).statusCode).toBe(403);
    const mine = await h.req("GET", "/api/support/me/tickets", rider);
    expect(mine.json<Json>().tickets.map((x: Json) => x.id)).toEqual([ticket.id]);
    expect((await h.req("POST", "/api/support/tickets", rider, { category: "LOST_ITEM", subject: "phone", description: "left it", tripId: t.id })).json()).toMatchObject({ error: "use_lost_items" });
  });

  it("a SAFETY ticket is P1 and opens an incident at once", async () => {
    const driver = await h.appUser([{ r: "DRIVER" }]);
    const rider = await h.appUser();
    const t = h.trip({ riderUserId: rider.id, driverUserId: driver.id });
    const res = await h.req("POST", "/api/support/tickets", driver, { category: "SAFETY", subject: "Rider was aggressive", description: "Shouting and threats", tripId: t.id });
    expect(res.statusCode, res.body).toBe(201);
    const row = await h.c.db.ticket.findUniqueOrThrow({ where: { id: res.json<Json>().ticket.id } });
    expect(row).toMatchObject({ priority: "P1", requesterKind: "DRIVER" });
    expect(row.incidentId).not.toBeNull();
    expect((await h.outbox("incident.opened")).some((e) => e.incidentId === row.incidentId && e.ticketId === row.id && e.source === "TICKET")).toBe(true);
  });

  it("the thread: internal notes stay with staff; the first public answer meets the SLA; a reply un-waits", async () => {
    const rider = await h.appUser();
    const created = await h.req("POST", "/api/support/tickets", rider, { category: "PAYMENT", subject: "Charged twice", description: "Two charges", cityId: "addis-ababa" });
    const id = created.json<Json>().ticket.id;
    const agent = await support();
    expect((await h.req("POST", `/api/support/tickets/${id}/messages`, agent, { body: "Looks like a provider retry", internal: true })).statusCode).toBe(201);
    expect((await h.c.db.ticket.findUniqueOrThrow({ where: { id } })).firstRespondedAt).toBeNull();
    await h.req("POST", `/api/support/tickets/${id}/claim`, agent);
    expect((await h.req("POST", `/api/support/tickets/${id}/messages`, agent, { body: "Which phone number paid?" })).statusCode).toBe(201);
    expect((await h.c.db.ticket.findUniqueOrThrow({ where: { id } })).firstRespondedAt).not.toBeNull();
    expect(h.pushes.some((p) => p.userId === rider.id && p.event === "support:ticket_message")).toBe(true);
    expect((await h.req("POST", `/api/support/tickets/${id}/status`, agent, { status: "WAITING_REQUESTER" })).json<Json>().ticket.status).toBe("WAITING_REQUESTER");

    const view = await h.req("GET", `/api/support/tickets/${id}`, rider);
    const messages = view.json<Json>().messages as Json[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ authorKind: "STAFF", authorUserId: null, internal: false });

    expect((await h.req("POST", `/api/support/tickets/${id}/messages`, rider, { body: "0911223344" })).statusCode).toBe(201);
    const staffView = await h.req("GET", `/api/support/tickets/${id}`, agent);
    expect(staffView.json<Json>().ticket).toMatchObject({ status: "IN_PROGRESS", assigneeUserId: agent.id });
    expect(staffView.json<Json>().messages).toHaveLength(3);
  });

  it("resolve with a decision, reopen within 7 days only, invalid moves refused, readers can't write", async () => {
    const rider = await h.appUser();
    const id = (await h.req("POST", "/api/support/tickets", rider, { category: "ACCOUNT", subject: "Can't sign in", description: "OTP never arrives", cityId: "addis-ababa" })).json<Json>().ticket.id;
    const agent = await support();
    expect((await h.req("POST", `/api/support/tickets/${id}/resolve`, agent, { resolution: "EXPLAINED", note: "Telegram code was sent; showed the user" })).json<Json>().ticket).toMatchObject({ status: "RESOLVED", resolution: "EXPLAINED" });
    expect((await h.outbox("ticket.resolved")).some((e) => e.ticketId === id && e.byUserId === agent.id)).toBe(true);
    expect((await h.outbox("audit.recorded")).some((e) => e.action === "ticket:update" && (e.resource as Json).id === id && e.service === "support-service")).toBe(true);
    expect((await h.req("POST", `/api/support/tickets/${id}/status`, agent, { status: "WAITING_REQUESTER" })).json()).toMatchObject({ error: "invalid_transition" });
    expect((await h.req("POST", `/api/support/tickets/${id}/messages`, rider, { body: "still broken" })).json()).toMatchObject({ error: "ticket_resolved" });
    const reopened = await h.req("POST", `/api/support/tickets/${id}/reopen`, rider, { reason: "still broken" });
    expect(reopened.json<Json>().ticket).toMatchObject({ status: "OPEN", resolution: null });

    await h.req("POST", `/api/support/tickets/${id}/resolve`, agent, { resolution: "NO_ACTION", note: "fixed on their side" });
    h.clock.now += 8 * DAY;
    expect((await h.req("POST", `/api/support/tickets/${id}/reopen`, rider, { reason: "again" })).json()).toMatchObject({ error: "reopen_window_closed" });
    h.clock.now -= 8 * DAY;

    const auditor = await h.staff([{ r: "ANALYST", city: "addis-ababa" }]);
    expect((await h.req("GET", `/api/support/tickets/${id}`, auditor)).statusCode).toBe(404);
    const onboarding = await h.staff([{ r: "ONBOARDING_OFFICER", city: "addis-ababa" }]);
    expect((await h.req("POST", `/api/support/tickets/${id}/claim`, onboarding)).statusCode).toBe(409); // readable and writable, but resolved
  });

  it("call center logs a ticket for a caller (audited, idempotent); filters: overdue, assignee, text and #ref", async () => {
    const cc = await h.staff([{ r: "CALL_CENTER_AGENT", city: "addis-ababa" }]);
    const caller = uuid();
    const body = { requesterUserId: caller, category: "FEEDBACK", subject: "Great driver", description: "Wants to thank Abebe", cityId: "addis-ababa" };
    const key = { "idempotency-key": `call-${uuid()}` };
    const a = await h.req("POST", "/api/support/tickets", cc, body, key);
    const b = await h.req("POST", "/api/support/tickets", cc, body, key);
    expect(a.statusCode, a.body).toBe(201);
    expect(b.json<Json>().ticket.id).toBe(a.json<Json>().ticket.id);
    const t = a.json<Json>().ticket;
    expect(t).toMatchObject({ source: "PHONE", priority: "P4", requester: { userId: caller, kind: "RIDER" }, createdByUserId: cc.id });
    expect((await h.outbox("audit.recorded")).some((e) => e.action === "ticket:create" && e.onBehalfOf === caller)).toBe(true);
    expect((await h.req("POST", "/api/support/tickets", cc, { ...body, cityId: "hawassa" })).statusCode).toBe(403);

    const agent = await support();
    const byRef = await h.req("GET", `/api/support/tickets?q=%23${t.ref}`, agent);
    expect(byRef.json<Json>().tickets.map((x: Json) => x.id)).toEqual([t.id]);
    expect((await h.req("GET", "/api/support/tickets?q=abebe%20thanks", agent)).json<Json>().tickets.length).toBe(0);
    expect((await h.req("GET", "/api/support/tickets?q=Abebe", agent)).json<Json>().tickets.map((x: Json) => x.id)).toContain(t.id);

    h.clock.now += 73 * HOUR;
    const overdue = await h.req("GET", "/api/support/tickets?overdue=true&category=FEEDBACK", agent);
    expect(overdue.json<Json>().tickets.find((x: Json) => x.id === t.id)).toMatchObject({ overdue: true });
    h.clock.now -= 73 * HOUR;
    await h.req("POST", `/api/support/tickets/${t.id}/assign`, agent, { assigneeUserId: agent.id });
    const mine = await h.req("GET", "/api/support/tickets?assignee=me", agent);
    expect(mine.json<Json>().tickets.map((x: Json) => x.id)).toEqual([t.id]);
    expect((await h.req("GET", "/api/support/tickets?status=IN_PROGRESS,OPEN&limit=1", agent)).json<Json>().next).not.toBeNull();
  });

  it("links refunds by id and follows their outcome from payment-service", async () => {
    const rider = await h.appUser();
    const id = (await h.req("POST", "/api/support/tickets", rider, { category: "PAYMENT", subject: "Overcharged", description: "120 ETB too much", cityId: "addis-ababa" })).json<Json>().ticket.id;
    const agent = await support();
    const refundId = uuid();
    expect((await h.req("POST", `/api/support/tickets/${id}/refunds`, agent, { refundId, amountMinor: 12000 })).statusCode).toBe(201);
    expect((await h.req("POST", `/api/support/tickets/${id}/refunds`, agent, { refundId })).json()).toMatchObject({ error: "already_linked" });
    const consumer = createConsumer({ brokers: ["127.0.0.1:1"], tickets: h.c.tickets, logger: { error: () => undefined } as never, createTopics: false });
    await consumer.handle("refund.succeeded", "not json");
    await consumer.handle("refund.succeeded", JSON.stringify({ refundId, paymentId: uuid() }));
    await consumer.handle("refund.succeeded", JSON.stringify({ refundId })); // replay: no second note
    const detail = (await h.req("GET", `/api/support/tickets/${id}`, agent)).json<Json>();
    expect(detail.refunds).toEqual([expect.objectContaining({ refundId, status: "SUCCEEDED", amountMinor: 12000 })]);
    expect(detail.messages.filter((m: Json) => m.authorKind === "SYSTEM")).toHaveLength(1);
  });

  it("timers: no reply in 72 h resolves; resolved for 7 days closes", async () => {
    const rider = await h.appUser();
    const id = (await h.req("POST", "/api/support/tickets", rider, { category: "TRIP", subject: "No-show fee", description: "I was there", cityId: "addis-ababa" })).json<Json>().ticket.id;
    const agent = await support();
    await h.req("POST", `/api/support/tickets/${id}/status`, agent, { status: "WAITING_REQUESTER", note: "asked for a screenshot" });
    h.clock.now += 73 * HOUR;
    await h.c.tickets.sweep();
    expect(await h.c.db.ticket.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "RESOLVED", resolution: "NO_ACTION", resolvedBy: null });
    h.clock.now += 8 * DAY;
    await h.c.tickets.sweep();
    expect((await h.c.db.ticket.findUniqueOrThrow({ where: { id } })).status).toBe("CLOSED");
    expect((await h.outbox("ticket.closed")).some((e) => e.ticketId === id && e.automatic === true)).toBe(true);
    h.clock.now -= 73 * HOUR + 8 * DAY;
  });
});

describe("lost items", () => {
  it("rider reports, driver answers found, fleet can read, staff closes it as returned", async () => {
    const rider = await h.appUser();
    const driver = await h.appUser([{ r: "DRIVER" }]);
    const fleetOrg = uuid();
    const fleet = await h.appUser([{ r: "FLEET_OWNER", org: fleetOrg }]);
    const t = h.trip({ riderUserId: rider.id, driverUserId: driver.id, fleetOrgId: fleetOrg, status: "completed", completedAt: new Date(h.clock.now - DAY) });
    const res = await h.req("POST", "/api/support/lost-items", rider, { tripId: t.id, description: "Black backpack on the back seat" });
    expect(res.statusCode, res.body).toBe(201);
    const item = res.json<Json>().lostItem;
    expect(item).toMatchObject({ status: "REPORTED", viewerRole: "RIDER" });
    expect(item).not.toHaveProperty("driverUserId");
    expect(await h.c.db.ticket.findUniqueOrThrow({ where: { id: item.ticketId } })).toMatchObject({ category: "LOST_ITEM", priority: "P2" });
    expect(h.pushes.some((p) => p.userId === driver.id && p.event === "support:lost_item")).toBe(true);
    expect((await h.req("POST", "/api/support/lost-items", rider, { tripId: t.id, description: "again" })).json()).toMatchObject({ error: "already_reported" });

    expect((await h.req("GET", "/api/support/me/lost-items", driver)).json<Json>().lostItems.map((l: Json) => l.id)).toEqual([item.id]);
    expect((await h.req("GET", `/api/support/lost-items/${item.id}`, fleet)).json<Json>().lostItem.viewerRole).toBe("FLEET");
    expect((await h.req("GET", `/api/support/lost-items/${item.id}`, await h.appUser([{ r: "DRIVER" }]))).statusCode).toBe(404);
    expect((await h.req("POST", `/api/support/lost-items/${item.id}/respond`, rider, { found: true })).statusCode).toBe(403);
    expect((await h.req("POST", `/api/support/lost-items/${item.id}/respond`, driver, { found: true, note: "It's here, can drop it at Bole" })).json<Json>().lostItem.status).toBe("FOUND");
    await h.req("POST", `/api/support/lost-items/${item.id}/messages`, rider, { body: "Thanks, Bole works at 6 pm" });

    const agent = await support();
    const list = await h.req("GET", "/api/support/lost-items?status=FOUND", agent);
    expect(list.json<Json>().lostItems.find((l: Json) => l.id === item.id)).toMatchObject({ driverUserId: driver.id, driverNotFoundCount: 0 });
    expect((await h.req("GET", "/api/support/lost-items", await dispatcher())).statusCode).toBe(403);
    const returned = await h.req("POST", `/api/support/lost-items/${item.id}/status`, agent, { status: "RETURNED", note: "Handed over at Bole" });
    expect(returned.json<Json>().lostItem.status).toBe("RETURNED");
    expect((await h.outbox("lost_item.returned")).some((e) => e.lostItemId === item.id)).toBe(true);
    expect(await h.c.db.ticket.findUniqueOrThrow({ where: { id: item.ticketId } })).toMatchObject({ status: "RESOLVED", resolution: "EXPLAINED" });
    // a staff status-change note is internal: rider and driver don't see it, the driver's note stays
    const thread = (await h.req("GET", `/api/support/lost-items/${item.id}`, rider)).json<Json>().messages;
    expect(thread.map((m: Json) => m.authorKind)).toEqual(["DRIVER", "RIDER"]);
    expect(JSON.stringify(thread)).not.toContain(driver.id);
    expect(JSON.stringify((await h.req("GET", `/api/support/lost-items/${item.id}`, driver)).json())).not.toContain("Handed over at Bole");
    const staffView = (await h.req("GET", `/api/support/lost-items/${item.id}`, agent)).json<Json>();
    expect(staffView.messages.map((m: Json) => [m.authorKind, m.internal])).toEqual([["DRIVER", false], ["RIDER", false], ["STAFF", true]]);
    expect((await h.c.db.lostItem.findUniqueOrThrow({ where: { id: item.id } })).driverNote).toBe("It's here, can drop it at Bole");
    expect((await h.c.db.ticket.findUniqueOrThrow({ where: { id: item.ticketId } })).resolutionNote).not.toContain("Bole");
  });

  it("a staff note is shared with rider and driver only with share: true", async () => {
    const rider = await h.appUser();
    const driver = await h.appUser([{ r: "DRIVER" }]);
    const t = h.trip({ riderUserId: rider.id, driverUserId: driver.id, status: "completed", completedAt: new Date(h.clock.now - HOUR) });
    const item = (await h.req("POST", "/api/support/lost-items", rider, { tripId: t.id, description: "Blue scarf" })).json<Json>().lostItem;
    await h.req("POST", `/api/support/lost-items/${item.id}/respond`, driver, { found: false, note: "Checked the car" });
    const agent = await support();
    expect((await h.req("POST", `/api/support/lost-items/${item.id}/status`, agent, { status: "FOUND", note: "Driver keeps forgetting; flagged" })).statusCode).toBe(200);
    expect((await h.req("POST", `/api/support/lost-items/${item.id}/status`, agent, { status: "RETURNED", note: "Ready at the Bole office", share: true })).statusCode).toBe(200);
    const thread = (await h.req("GET", `/api/support/lost-items/${item.id}`, rider)).json<Json>().messages.map((m: Json) => m.body);
    expect(thread).toEqual(["Checked the car", "Ready at the Bole office"]);
    expect((await h.c.db.lostItem.findUniqueOrThrow({ where: { id: item.id } })).driverNote).toBe("Checked the car");
  });

  it("only within 7 days; repeat not-found is counted; not found for 48 h closes", async () => {
    const rider = await h.appUser();
    const driver = await h.appUser([{ r: "DRIVER" }]);
    const old = h.trip({ riderUserId: rider.id, driverUserId: driver.id, status: "completed", completedAt: new Date(h.clock.now - 8 * DAY) });
    expect((await h.req("POST", "/api/support/lost-items", rider, { tripId: old.id, description: "umbrella" })).json()).toMatchObject({ error: "report_window_closed" });

    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const t = h.trip({ riderUserId: rider.id, driverUserId: driver.id, status: "completed", completedAt: new Date(h.clock.now - HOUR) });
      const l = (await h.req("POST", "/api/support/lost-items", rider, { tripId: t.id, description: `item ${i}` })).json<Json>().lostItem;
      await h.req("POST", `/api/support/lost-items/${l.id}/respond`, driver, { found: false });
      ids.push(l.id);
    }
    const agent = await support();
    expect((await h.req("GET", `/api/support/lost-items/${ids[1]}`, agent)).json<Json>().lostItem.driverNotFoundCount).toBe(2);
    h.clock.now += 49 * HOUR;
    await h.c.lostItems.sweep();
    expect((await h.c.db.lostItem.findUniqueOrThrow({ where: { id: ids[0] } })).status).toBe("CLOSED");
    h.clock.now -= 49 * HOUR;
  });
});

describe("SOS", () => {
  it("a rider presses SOS: one alert, the city queue sees it, dispatchers acknowledge, safety resolves", async () => {
    const rider = await h.appUser();
    const driver = await h.appUser([{ r: "DRIVER" }]);
    const t = h.trip({ riderUserId: rider.id, driverUserId: driver.id });
    const body = { tripId: t.id, location: { lat: 9.01, lng: 38.76, accuracy: 12 } };
    const first = await h.req("POST", "/api/support/sos", rider, body);
    expect(first.statusCode, first.body).toBe(201);
    const alertId = first.json<Json>().alert.id;
    const again = await h.req("POST", "/api/support/sos", rider, { ...body, location: { lat: 9.02, lng: 38.77 } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, alert: { id: alertId } });
    expect((await h.outbox("sos.triggered")).filter((e) => e.alertId === alertId)).toHaveLength(1);

    const d = await dispatcher();
    const queue = await h.req("GET", "/api/support/sos", d);
    expect(queue.json<Json>().alerts.find((a: Json) => a.id === alertId)).toMatchObject({ status: "OPEN", role: "RIDER", driverUserId: driver.id, location: { lat: 9.02, lng: 38.77 } });
    expect((await h.req("GET", "/api/support/sos", await dispatcher("hawassa"))).json<Json>().alerts.find((a: Json) => a.id === alertId)).toBeUndefined();
    expect((await h.req("GET", `/api/support/sos/${alertId}`, await safety("hawassa"))).statusCode).toBe(404);

    h.clock.now += 61_000;
    expect((await h.req("GET", `/api/support/sos/${alertId}`, d)).json<Json>().alert.ackOverdue).toBe(true);
    const ack = await h.req("POST", `/api/support/sos/${alertId}/acknowledge`, d, { note: "Calling the rider" });
    expect(ack.json<Json>().alert).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedBy: d.id });
    expect(h.pushes.some((p) => p.userId === rider.id && p.event === "support:sos")).toBe(true);
    expect((await h.req("POST", `/api/support/sos/${alertId}/acknowledge`, d)).json()).toMatchObject({ error: "invalid_transition" });
    expect((await h.req("POST", `/api/support/sos/${alertId}/resolve`, d, { outcome: "FALSE_ALARM", note: "pocket press" })).statusCode).toBe(403);

    const so = await safety();
    const done = await h.req("POST", `/api/support/sos/${alertId}/resolve`, so, { outcome: "ESCALATED", note: "Police called", emergencyReference: "AA-991" });
    expect(done.json<Json>().alert).toMatchObject({ status: "RESOLVED", outcome: "ESCALATED", emergencyReference: "AA-991" });
    expect((await h.outbox("sos.resolved")).some((e) => e.alertId === alertId && e.outcome === "ESCALATED")).toBe(true);
    expect((await h.outbox("audit.recorded")).some((e) => e.action === "sos:respond" && (e.resource as Json).id === alertId)).toBe(true);
    expect((await h.req("GET", `/api/support/sos/${alertId}`, rider)).json<Json>().alert).toEqual(expect.objectContaining({ status: "RESOLVED" }));
    expect((await h.req("GET", `/api/support/sos/${alertId}`, rider)).json<Json>().alert).not.toHaveProperty("resolvedBy");
    h.clock.now -= 61_000;

    // after the short window a new press makes a new alert
    h.clock.now += 3 * MIN;
    const later = await h.req("POST", "/api/support/sos", rider, body);
    expect(later.statusCode).toBe(201);
    h.clock.now -= 3 * MIN;
  });

  it("only on an active trip or 30 min after drop-off, only for its parties; accepted unverified when trip-service is down", async () => {
    const rider = await h.appUser();
    const done = h.trip({ riderUserId: rider.id, status: "completed", completedAt: new Date(h.clock.now - 31 * MIN) });
    const loc = { lat: 9, lng: 38.7 };
    expect((await h.req("POST", "/api/support/sos", rider, { tripId: done.id, location: loc })).json()).toMatchObject({ error: "sos_unavailable" });
    const recent = h.trip({ riderUserId: rider.id, status: "completed", completedAt: new Date(h.clock.now - 10 * MIN) });
    expect((await h.req("POST", "/api/support/sos", rider, { tripId: recent.id, location: loc })).statusCode).toBe(201);
    const other = h.trip({ riderUserId: uuid() });
    expect((await h.req("POST", "/api/support/sos", rider, { tripId: other.id, location: loc })).statusCode).toBe(404);
    expect((await h.req("POST", "/api/support/sos", await safety(), { tripId: other.id, location: loc })).statusCode).toBe(403);

    h.tripState.down = true;
    try {
      expect((await h.req("POST", "/api/support/sos", rider, { tripId: uuid(), location: loc })).statusCode).toBe(503);
      const res = await h.req("POST", "/api/support/sos", rider, { tripId: uuid(), location: loc, cityId: "hawassa" });
      expect(res.statusCode, res.body).toBe(201);
      expect(await h.c.db.sosAlert.findUniqueOrThrow({ where: { id: res.json<Json>().alert.id } })).toMatchObject({ tripVerified: false, cityId: "hawassa" });
    } finally {
      h.tripState.down = false;
    }
  });

  it("a suspended user's token is refused (Redis deny list)", async () => {
    const rider = await h.appUser();
    await h.redis.set(`deny:${rider.id}`, "1");
    expect((await h.req("GET", "/api/support/me/tickets", rider)).json()).toMatchObject({ error: "token_revoked" });
  });
});

describe("incidents", () => {
  it("from an SOS: parties copied, linked once; notes, actions, resolve; never deleted", async () => {
    const rider = await h.appUser();
    const driverId = uuid();
    const t = h.trip({ riderUserId: rider.id, driverUserId: driverId });
    const alertId = (await h.req("POST", "/api/support/sos", rider, { tripId: t.id, location: { lat: 9, lng: 38.7 } })).json<Json>().alert.id;
    const so = await safety();
    const opened = await h.req("POST", "/api/support/incidents", so, { sosAlertId: alertId, category: "HARASSMENT", severity: "HIGH", summary: "Rider reports harassment" });
    expect(opened.statusCode, opened.body).toBe(201);
    const inc = opened.json<Json>().incident;
    expect(inc).toMatchObject({ source: "SOS", tripId: t.id, cityId: "addis-ababa" });
    expect(inc.subjectUserIds.sort()).toEqual([rider.id, driverId].sort());
    expect((await h.req("POST", "/api/support/incidents", so, { sosAlertId: alertId, category: "OTHER", severity: "LOW", summary: "dup" })).json()).toMatchObject({ error: "already_linked" });
    expect((await h.req("POST", "/api/support/incidents", await dispatcher(), { cityId: "addis-ababa", category: "OTHER", severity: "LOW", summary: "x" })).statusCode).toBe(403);
    expect((await h.req("GET", `/api/support/incidents/${inc.id}`, await safety("hawassa"))).statusCode).toBe(404);

    expect((await h.req("PATCH", `/api/support/incidents/${inc.id}`, so, { status: "INVESTIGATING", ownerUserId: so.id })).json<Json>().incident).toMatchObject({ status: "INVESTIGATING", ownerUserId: so.id });
    expect((await h.req("POST", `/api/support/incidents/${inc.id}/notes`, so, { body: "Driver statement taken" })).statusCode).toBe(201);
    const until = new Date(h.clock.now + 14 * DAY).toISOString();
    expect((await h.req("POST", `/api/support/incidents/${inc.id}/actions`, so, { userId: driverId, kind: "SUSPENDED", until, reference: "auth suspension" })).statusCode).toBe(201);
    const resolved = await h.req("POST", `/api/support/incidents/${inc.id}/resolve`, so, { outcome: "SUSPENDED_TEMPORARY", note: "Two weeks, then review" });
    expect(resolved.json<Json>().incident).toMatchObject({ status: "RESOLVED", outcome: "SUSPENDED_TEMPORARY" });
    expect((await h.req("PATCH", `/api/support/incidents/${inc.id}`, so, { severity: "LOW" })).json()).toMatchObject({ error: "incident_resolved" });

    const detail = (await h.req("GET", `/api/support/incidents/${inc.id}`, so)).json<Json>();
    expect(detail.sosAlerts.map((a: Json) => a.id)).toEqual([alertId]);
    expect(detail.actions[0]).toMatchObject({ userId: driverId, kind: "SUSPENDED", until });
    expect((await h.outbox("incident.resolved")).some((e) => e.incidentId === inc.id)).toBe(true);
    expect((await h.req("GET", "/api/support/incidents?status=RESOLVED", so)).json<Json>().incidents.map((i: Json) => i.id)).toContain(inc.id);

    await expect(h.c.db.$executeRaw`DELETE FROM incident_note`).rejects.toThrow(/legal hold/);
    await expect(h.c.db.$executeRaw`DELETE FROM sos_alert`).rejects.toThrow(/legal hold/);
  });

  it("from a ticket, and by hand", async () => {
    const rider = await h.appUser();
    const ticketId = (await h.req("POST", "/api/support/tickets", rider, { category: "TRIP", subject: "Driver drove recklessly", description: "Speeding", cityId: "addis-ababa" })).json<Json>().ticket.id;
    const so = await safety();
    const fromTicket = await h.req("POST", "/api/support/incidents", so, { ticketId, category: "DANGEROUS_DRIVING", severity: "MEDIUM", summary: "Speeding complaint" });
    expect(fromTicket.json<Json>().incident).toMatchObject({ source: "TICKET", subjectUserIds: [rider.id] });
    expect((await h.c.db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).incidentId).toBe(fromTicket.json<Json>().incident.id);
    expect((await h.req("POST", "/api/support/incidents", so, { category: "THEFT", severity: "LOW", summary: "no city" })).statusCode).toBe(400);
    expect((await h.req("POST", "/api/support/incidents", so, { cityId: "addis-ababa", category: "THEFT", severity: "LOW", summary: "Phone stolen at pickup" })).json<Json>().incident.source).toBe("MANUAL");
  });
});

describe("internal", () => {
  it("/internal/ops/outbox needs the service token", async () => {
    expect((await h.app.inject({ method: "GET", url: "/internal/ops/outbox" })).statusCode).toBe(401);
    const res = await h.app.inject({ method: "GET", url: "/internal/ops/outbox", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.json<Json>().pending).toBeGreaterThan(0);
  });
});
