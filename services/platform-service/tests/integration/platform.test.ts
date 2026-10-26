import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, TOKEN, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h?.close());

describe("live settings", () => {
  it("an ordinary change applies at once, with history, a new version, an audit event and a publish", async () => {
    const a = await h.superAdmin();
    const before = (await h.c.settings.snapshot()).version;
    const res = await h.req("PUT", "/api/platform/settings/match.offerSeconds", a, { value: 20, reason: "drivers need more time at night" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "APPLIED", version: before + 1 });
    expect(h.published.at(-1)).toBe(String(before + 1));
    const snap = await h.app.inject({ method: "GET", url: "/internal/settings/snapshot", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(snap.json<{ global: Record<string, unknown> }>().global["match.offerSeconds"]).toBe(20);
    const history = await h.req("GET", "/api/platform/settings/history?key=match.offerSeconds", a);
    expect(history.json<{ history: { oldValue: unknown; newValue: unknown; changedBy: string }[] }>().history[0]).toMatchObject({ oldValue: null, newValue: 20, changedBy: a.id });
    expect((await h.outbox("audit.recorded")).some((e) => e.action === "settings:change" && String(e.reason).includes("default → 20"))).toBe(true);

    // back to the default
    await h.req("PUT", "/api/platform/settings/match.offerSeconds", a, { value: null, reason: "back to normal" });
    expect((await h.c.settings.snapshot()).global).not.toHaveProperty("match.offerSeconds");
  });

  it("a sensitive change waits for a second super admin", async () => {
    const a = await h.superAdmin();
    const b = await h.superAdmin();
    const res = await h.req("PUT", "/api/platform/settings/cancel.feeMinor", a, { value: 4000, cityId: "addis-ababa", reason: "fee review for Addis" });
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json<{ change: { id: string } }>().change.id;
    expect((await h.c.settings.snapshot()).cities["addis-ababa"]?.["cancel.feeMinor"]).toBeUndefined();
    expect((await h.req("PUT", "/api/platform/settings/cancel.feeMinor", b, { value: 5000, cityId: "addis-ababa", reason: "a competing change" })).json()).toMatchObject({ error: "change_pending" });
    expect((await h.req("POST", `/api/platform/settings/changes/${id}/approve`, a, {})).json()).toMatchObject({ error: "maker_is_checker" });
    const ok = await h.req("POST", `/api/platform/settings/changes/${id}/approve`, b, {});
    expect(ok.statusCode, ok.body).toBe(200);
    const snap = await h.c.settings.snapshot();
    expect(snap.cities["addis-ababa"]?.["cancel.feeMinor"]).toBe(4000);
    const hist = await h.c.db.settingHistory.findFirstOrThrow({ where: { key: "cancel.feeMinor" } });
    expect(hist).toMatchObject({ changedBy: a.id, approvedBy: b.id, cityId: "addis-ababa" });
  });

  it("refuses bad values, city overrides of global settings and unknown cities", async () => {
    const a = await h.superAdmin();
    expect((await h.req("PUT", "/api/platform/settings/match.offerSeconds", a, { value: 2, reason: "too quick" })).json()).toMatchObject({ error: "invalid_value" });
    expect((await h.req("PUT", "/api/platform/settings/match.offerSeconds", a, { value: 20, cityId: "addis-ababa", reason: "per city" })).statusCode).toBe(400);
    expect((await h.req("PUT", "/api/platform/settings/cancel.freeSeconds", a, { value: 60, cityId: "nowhere", reason: "unknown city" })).statusCode).toBe(400);
    expect((await h.req("PUT", "/api/platform/settings/no.such", a, { value: 1, reason: "unknown key" })).statusCode).toBe(404);
  });

  it("who may do what: dispatchers nothing, auditors read only", async () => {
    const d = await h.staff([{ r: "DISPATCHER", city: "addis-ababa" }]);
    expect((await h.req("GET", "/api/platform/settings", d)).statusCode).toBe(403);
    const auditor = await h.staff([{ r: "AUDITOR", g: true }]);
    expect((await h.req("GET", "/api/platform/settings", auditor)).statusCode).toBe(200);
    expect((await h.req("PUT", "/api/platform/settings/match.offerSeconds", auditor, { value: 20, reason: "auditor tries" })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "GET", url: "/internal/settings/snapshot" })).statusCode).toBe(401);
  });
});

describe("cities, vehicle types, client configuration", () => {
  it("built-in cities are seeded and synced to auth-service; a new city syncs first and enters the snapshot", async () => {
    expect(h.syncedCities.map((c) => c.id)).toEqual(expect.arrayContaining(["addis-ababa", "hawassa"]));
    const a = await h.superAdmin();
    const body = { id: "bahir-dar", name: "Bahir Dar", timezone: "Africa/Addis_Ababa", enabled: false, bbox: { minLat: 11.5, minLng: 37.3, maxLat: 11.7, maxLng: 37.5 } };
    h.identityState.down = true;
    expect((await h.req("POST", "/api/platform/cities", a, body)).statusCode).toBe(503);
    expect(await h.c.db.city.findUnique({ where: { id: "bahir-dar" } })).toBeNull();
    h.identityState.down = false;
    expect((await h.req("POST", "/api/platform/cities", a, body)).statusCode).toBe(201);
    expect((await h.c.settings.snapshot()).cityList.map((c) => c.id)).toContain("bahir-dar");

    const cfg = await h.app.inject({ method: "GET", url: "/api/platform/client-config" });
    expect(cfg.json<{ cities: { id: string }[] }>().cities.map((c) => c.id)).not.toContain("bahir-dar"); // disabled
    await h.req("PUT", "/api/platform/cities/bahir-dar", a, { ...body, enabled: true });
    expect((await h.app.inject({ method: "GET", url: "/api/platform/client-config" })).json<{ cities: { id: string }[] }>().cities.map((c) => c.id)).toContain("bahir-dar");
  });

  it("vehicle types and flags reach the client configuration", async () => {
    const a = await h.superAdmin();
    const res = await h.req("PUT", "/api/platform/vehicle-types/electric", a, { name: "Electric", seatsMin: 3, seatsMax: 4, enabled: true, cities: ["addis-ababa"] });
    expect(res.statusCode, res.body).toBe(200);
    await h.req("PUT", "/api/platform/settings/features.phoneBooking", a, { value: false, reason: "call center closed today" });
    await h.req("PUT", "/api/platform/settings/features.sos", a, { value: true, reason: "safety desk staffed" });
    const cfg = (await h.app.inject({ method: "GET", url: "/api/platform/client-config" })).json<{ vehicleTypes: { code: string }[]; features: Record<string, boolean>; maintenance: { newTripsPaused: boolean } }>();
    expect(cfg.vehicleTypes.map((t) => t.code)).toContain("electric");
    expect(cfg.features.phoneBooking).toBe(false);
    // the phone app's modules built ahead of their services stay hidden until switched on
    expect(cfg.features).toMatchObject({ sos: true, scheduledRides: false, support: false, promos: false, accountDeletion: false });
    expect(cfg.maintenance.newTripsPaused).toBe(false);
  });

  it("announcements show to their audience during their window", async () => {
    const a = await h.superAdmin();
    const start = new Date(h.clock.now - 60_000).toISOString();
    const res = await h.req("POST", "/api/platform/announcements", a, { title: "Holiday hours", body: "The call center closes at 6 pm today.", audiences: ["staff"], startsAt: start });
    expect(res.statusCode, res.body).toBe(201);
    const later = await h.req("POST", "/api/platform/announcements", a, { title: "Coming soon", body: "Electric cars next month.", audiences: ["rider"], startsAt: new Date(h.clock.now + 86_400_000).toISOString() });
    expect(later.statusCode).toBe(201);
    const staffView = (await h.app.inject({ method: "GET", url: "/api/platform/client-config?audience=staff" })).json<{ announcements: { title: string }[] }>();
    expect(staffView.announcements.map((x) => x.title)).toEqual(["Holiday hours"]);
    expect((await h.app.inject({ method: "GET", url: "/api/platform/client-config?audience=rider" })).json<{ announcements: unknown[] }>().announcements).toEqual([]);
    await h.req("POST", `/api/platform/announcements/${res.json<{ id: string }>().id}/archive`, a, {});
    expect((await h.app.inject({ method: "GET", url: "/api/platform/client-config?audience=staff" })).json<{ announcements: unknown[] }>().announcements).toEqual([]);
  });

  it("the system page reports unreachable services as down", async () => {
    const a = await h.superAdmin();
    const res = await h.req("GET", "/api/platform/system?refresh=true", a);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ services: { name: string; status: string }[] }>().services).toEqual([expect.objectContaining({ name: "auth-service", status: "down" })]);
  });
});
