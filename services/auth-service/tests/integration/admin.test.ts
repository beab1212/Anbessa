import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, getAuthzSnapshot } from "@ride-app/shared-authz";
import { AppUser, claimsOf, createHarness, createStaff, INTERNAL_TOKEN, phone, type Harness, type StaffUser } from "./harness.js";

let h: Harness;
let superA: StaffUser;
let superB: StaffUser;

beforeAll(async () => {
  h = await createHarness();
  superA = await createStaff(h, { role: "super_admin" });
  superB = await createStaff(h, { role: "super_admin" });
});
afterAll(() => h?.close());

const marketer = { userId: "m", audience: "ride-admin" as const, roles: [{ role: "MARKETING", scope: "CITY" as const, cityId: "addis-ababa" }], permissionVersion: 0, amr: [] };
const approve = (by: StaffUser, id: string) => by.identity("POST", `/api/identity/approvals/${id}/approve`, {});

describe("permission matrix: maker–checker, guardrails, live", () => {
  it("a change waits for a second super admin, then takes effect without a restart", async () => {
    expect(can(marketer, "promo:manage", { cityId: "addis-ababa" })).toBe(true);
    const before = getAuthzSnapshot().version;
    const res = await superA.identity("POST", "/api/identity/authz/changes", { roleCode: "MARKETING", set: [{ permission: "promo:manage", scope: null }], reason: "promos move to the growth team" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    // one pending change per role
    expect((await superA.identity("POST", "/api/identity/authz/changes", { roleCode: "MARKETING", set: [{ permission: "campaign:send", scope: null }], reason: "a second change at once" })).json()).toMatchObject({ error: "change_pending" });
    expect((await approve(superA, id)).json()).toMatchObject({ error: "maker_is_checker" });
    expect(can(marketer, "promo:manage", { cityId: "addis-ababa" })).toBe(true);

    const ok = await approve(superB, id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(getAuthzSnapshot().version).toBe(before + 1);
    expect(can(marketer, "promo:manage", { cityId: "addis-ababa" })).toBe(false);
    const snap = await h.app.inject({ method: "GET", url: "/internal/authz/snapshot", headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
    expect(snap.json<{ matrix: Record<string, Record<string, string>> }>().matrix.MARKETING).not.toHaveProperty("promo:manage");
    const audits = await h.c.db.outbox.findMany({ where: { topic: "audit.recorded" } });
    expect(audits.some((a) => (a.payload as { action: string }).action === "authz:change")).toBe(true);
  });

  it("guardrails refuse the change up front", async () => {
    const res = await superA.identity("POST", "/api/identity/authz/changes", { roleCode: "SUPER_ADMIN", set: [{ permission: "authz:approve", scope: null }], reason: "trying to lock the platform" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "guardrail" });
    const preview = await superA.identity("POST", "/api/identity/authz/preview", { roleCode: "DISPATCHER", set: [{ permission: "trip:read", scope: "S" }] });
    expect(preview.json<{ problems: string[] }>().problems.join()).toMatch(/staff roles/);
  });

  it("only super admins propose; a dispatcher can read the matrix but not change it", async () => {
    const d = await createStaff(h);
    await grant(d.id, "DISPATCHER", "addis-ababa");
    expect((await d.identity("GET", "/api/identity/authz")).statusCode).toBe(200);
    expect((await d.identity("POST", "/api/identity/authz/changes", { roleCode: "DISPATCHER", set: [{ permission: "trip:read_gps_trace", scope: "C" }], reason: "self-service attempt" })).statusCode).toBe(403);
  });

  it("custom roles: created with approval, granted like any staff role, in the token; can't be archived while held", async () => {
    const created = await superA.identity("POST", "/api/identity/authz/changes", {
      create: { label: "Quality review", storage: "city" }, set: [{ permission: "trip:read", scope: "C" }], reason: "new QA team in Addis",
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((await approve(superB, created.json<{ id: string }>().id)).statusCode).toBe(200);

    const s = await createStaff(h);
    await grant(s.id, "CUSTOM_QUALITY_REVIEW", "addis-ababa");
    expect(claimsOf(await s.accessToken()).roles).toEqual([{ r: "CUSTOM_QUALITY_REVIEW", city: "addis-ababa" }]);

    const archive = await superA.identity("POST", "/api/identity/authz/changes", { roleCode: "CUSTOM_QUALITY_REVIEW", set: [], archive: true, reason: "team disbanded already" });
    expect(archive.json<{ message: string }>().message).toMatch(/still hold this role/);
  });
});

async function grant(userId: string, role: string, cityId?: string) {
  const req = await superA.identity("POST", "/api/identity/staff-role-requests", { userId, role, cityId, reason: "integration test grant" });
  expect(req.statusCode, req.body).toBe(201);
  expect((await approve(superB, req.json<{ id: string }>().id)).statusCode).toBe(200);
}

describe("approvals inbox", () => {
  it("lists every action; the maker withdraws; expired requests are recorded and can't be approved", async () => {
    const s = await createStaff(h);
    const a = await superA.identity("POST", "/api/identity/staff-role-requests", { userId: s.id, role: "ANALYST", cityId: "addis-ababa", reason: "reports for the city office" });
    const b = await superA.identity("POST", "/api/identity/staff-role-requests", { userId: s.id, role: "MARKETING", cityId: "addis-ababa", reason: "campaign support this month" });
    const inbox = await superB.identity("GET", "/api/identity/approvals?status=PENDING");
    expect(inbox.json<{ approvals: { id: string }[] }>().approvals.map((x) => x.id)).toEqual(expect.arrayContaining([a.json<{ id: string }>().id, b.json<{ id: string }>().id]));

    expect((await superB.identity("POST", `/api/identity/approvals/${a.json<{ id: string }>().id}/cancel`, {})).statusCode).toBe(403);
    expect((await superA.identity("POST", `/api/identity/approvals/${a.json<{ id: string }>().id}/cancel`, {})).json()).toMatchObject({ status: "CANCELLED" });

    const bid = b.json<{ id: string }>().id;
    await h.c.db.approvalRequest.update({ where: { id: bid }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await h.c.identity.approvals.expire()).toBeGreaterThanOrEqual(1);
    expect((await h.c.db.approvalRequest.findUniqueOrThrow({ where: { id: bid } })).status).toBe("EXPIRED");
    expect((await approve(superB, bid)).json()).toMatchObject({ error: "not_pending" });
  });
});

describe("directory, sessions and MFA", () => {
  it("finds riders with masked phones and shows staff with their roles", async () => {
    const r = new AppUser(h, phone());
    const { user } = await r.signIn();
    const list = await superA.identity("GET", `/api/identity/users?q=${r.phone.slice(-6)}&kind=rider`);
    expect(list.statusCode, list.body).toBe(200);
    const row = list.json<{ users: { id: string; phone: string }[] }>().users.find((u) => u.id === user.id)!;
    expect(row.phone).not.toBe(r.phone);
    expect(row.phone).toContain("•••");

    const staff = await superA.identity("GET", "/api/identity/users?kind=staff");
    expect(staff.json<{ users: { id: string; roles: { role: string; label: string }[] }[] }>().users.find((u) => u.id === superB.id)!.roles).toEqual([expect.objectContaining({ role: "SUPER_ADMIN", label: "Super admin" })]);

    const detail = await superA.identity("GET", `/api/identity/users/${user.id}`);
    expect(detail.json<{ sessions: unknown[]; roles: unknown[] }>()).toMatchObject({ sessions: [expect.objectContaining({ surface: "app", active: true })] });
  });

  it("signing someone out everywhere ends their sessions and refuses their current token", async () => {
    const r = new AppUser(h, phone());
    const { user } = await r.signIn();
    const token = await r.accessToken();
    const res = await superA.identity("POST", `/api/identity/users/${user.id}/sessions/revoke`, { reason: "lost phone reported by the rider" });
    expect(res.statusCode, res.body).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/api/identity/me", headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ error: "token_outdated" });
    expect((await r.call("GET", "/api/auth/token")).statusCode).toBe(401);
  });

  it("resets a staff member's authenticator at once; a super admin's needs a second super admin", async () => {
    const s = await createStaff(h);
    const res = await superA.identity("POST", `/api/identity/users/${s.id}/reset-mfa`, { reason: "phone with the authenticator was stolen" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ temporaryPassword: string }>().temporaryPassword).toHaveLength(24);
    expect(await h.c.db.user.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ twoFactorEnabled: false, mustChangePassword: true });

    const third = await createStaff(h, { role: "super_admin" });
    const pending = await superA.identity("POST", `/api/identity/users/${third.id}/reset-mfa`, { reason: "new phone, authenticator not moved" });
    expect(pending.json()).toMatchObject({ pendingApproval: expect.any(String) });
    expect((await h.c.db.user.findUniqueOrThrow({ where: { id: third.id } })).twoFactorEnabled).toBe(true);
    const done = await approve(superB, pending.json<{ pendingApproval: string }>().pendingApproval);
    expect(done.json()).toMatchObject({ temporaryPassword: expect.any(String) });
  });

  it("staff sign-ins are audited; aggregates need report:read", async () => {
    const audits = await h.c.db.outbox.findMany({ where: { topic: "audit.recorded" } });
    expect(audits.some((a) => (a.payload as { action: string; actorId: string }).action === "staff:sign_in")).toBe(true);
    expect((await superA.identity("GET", "/api/identity/stats")).json()).toMatchObject({ users: expect.any(Number), staff: expect.any(Number) });
    const d = await createStaff(h);
    await grant(d.id, "DISPATCHER", "addis-ababa");
    expect((await d.identity("GET", "/api/identity/stats")).statusCode).toBe(403);
  });

  it("platform-service syncs cities, with their staff organisation", async () => {
    const res = await h.app.inject({ method: "PUT", url: "/internal/cities/hawassa", headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, payload: { name: "Hawassa", timezone: "Africa/Addis_Ababa" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await h.c.db.organization.findFirst({ where: { kind: "STAFF_CITY", cityId: "hawassa" } })).toBeTruthy();
  });
});
