import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, getAuthzSnapshot } from "@ride-app/shared-authz";
import { AppUser, claimsOf, createHarness, createStaff, INTERNAL_TOKEN, phone, StaffUser, type Harness } from "./harness.js";

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

async function hawassa() {
  const res = await h.app.inject({ method: "PUT", url: "/internal/cities/hawassa", headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, payload: { name: "Hawassa", timezone: "Africa/Addis_Ababa" } });
  expect(res.statusCode, res.body).toBe(200);
}

let orgN = 0;
async function partnerOrg(cityId: string, kind: "FLEET" | "CORPORATE" = "FLEET") {
  const id = crypto.randomUUID();
  const n = orgN++;
  await h.c.db.organization.create({
    data: { id, name: `Org ${n}`, slug: `org-${id.slice(0, 8)}`, kind, cityId, legalName: `Org ${n} PLC`, tin: String(Date.now() % 1e6).padStart(6, "0") + String(n).padStart(4, "0"), status: "VERIFIED", createdAt: new Date() },
  });
  return id;
}

describe("city-scoped staff: directory, overview, companies", () => {
  it("a city-scoped holder of user:read_masked reads the masked directory; PII, devices and writes stay closed", async () => {
    const r = new AppUser(h, phone());
    const { user } = await r.signIn();
    const d = await createStaff(h);
    await grant(d.id, "DISPATCHER", "addis-ababa");

    const list = await d.identity("GET", `/api/identity/users?q=${r.phone.slice(-6)}`);
    expect(list.statusCode, list.body).toBe(200);
    const row = list.json<{ users: { id: string; phone: string }[] }>().users.find((u) => u.id === user.id)!;
    expect(row.phone).toContain("•••");

    const detail = await d.identity("GET", `/api/identity/users/${user.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const sessions = detail.json<{ phone: string; sessions: { ipAddress: string | null; userAgent: string | null }[] }>();
    expect(sessions.phone).toContain("•••");
    expect(sessions.sessions.length).toBeGreaterThan(0);
    expect(sessions.sessions.every((s) => s.ipAddress === null && s.userAgent === null)).toBe(true);

    // writes keep their own scope
    expect((await d.identity("POST", `/api/identity/users/${user.id}/sessions/revoke`, { reason: "should not be allowed here" })).statusCode).toBe(403);
    expect((await d.identity("POST", `/api/identity/users/${user.id}/suspend`, { reason: "should not be allowed here", cityId: "addis-ababa" })).statusCode).toBe(403);

    // no grant anywhere: still refused
    const none = await createStaff(h);
    expect((await none.identity("GET", "/api/identity/users")).statusCode).toBe(403);
    expect((await none.identity("GET", `/api/identity/users/${user.id}`)).statusCode).toBe(403);
  });

  it("overview aggregates: a city-scoped report reader passes its city; a global one may omit it", async () => {
    await hawassa();
    const a = await createStaff(h);
    await grant(a.id, "ANALYST", "addis-ababa");
    expect((await a.identity("GET", "/api/identity/stats")).statusCode).toBe(403);
    expect((await a.identity("GET", "/api/identity/stats?cityId=hawassa")).statusCode).toBe(403);
    const mine = await a.identity("GET", "/api/identity/stats?cityId=addis-ababa");
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json()).toMatchObject({ cityId: "addis-ababa", users: expect.any(Number), staff: expect.any(Number) });
    // the analyst is staff of Addis Ababa, so that city's staff count includes them
    expect(mine.json<{ staff: number }>().staff).toBeGreaterThanOrEqual(1);

    const all = await superA.identity("GET", "/api/identity/stats");
    expect(all.json()).toMatchObject({ cityId: null });
    expect(all.json<{ staff: number }>().staff).toBeGreaterThanOrEqual(mine.json<{ staff: number }>().staff);
    expect((await superA.identity("GET", "/api/identity/stats?cityId=addis-ababa")).statusCode).toBe(200);
  });

  it("org:suspend holders list and open the companies they may suspend, in their cities only", async () => {
    await hawassa();
    const addis = await partnerOrg("addis-ababa");
    const south = await partnerOrg("hawassa", "CORPORATE");
    const staffOrg = (await h.c.db.organization.findFirstOrThrow({ where: { kind: "STAFF_CITY", cityId: "addis-ababa" } })).id;

    const safety = await createStaff(h);
    await grant(safety.id, "SAFETY_OFFICER", "addis-ababa");
    const list = await safety.identity("GET", "/api/identity/organizations");
    expect(list.statusCode, list.body).toBe(200);
    const ids = list.json<{ id: string; cityId: string; kind: string }[]>().map((o) => o.id);
    expect(ids).toContain(addis);
    expect(ids).not.toContain(south);
    expect(list.json<{ cityId: string; kind: string }[]>().every((o) => o.cityId === "addis-ababa" && (o.kind === "FLEET" || o.kind === "CORPORATE"))).toBe(true);
    expect((await safety.identity("GET", "/api/identity/organizations?cityId=addis-ababa")).statusCode).toBe(200);
    expect((await safety.identity("GET", "/api/identity/organizations?cityId=hawassa")).statusCode).toBe(403);
    expect((await safety.identity("GET", `/api/identity/organizations/${addis}`)).json()).toMatchObject({ id: addis, cityId: "addis-ababa", members: 0 });
    expect((await safety.identity("GET", `/api/identity/organizations/${south}`)).statusCode).toBe(403);
    expect((await safety.identity("GET", `/api/identity/organizations/${staffOrg}`)).statusCode).toBe(404);

    // a global org:suspend holder (finance officer) sees every city
    const finance = await createStaff(h);
    await grant(finance.id, "FINANCE_OFFICER");
    const everywhere = (await finance.identity("GET", "/api/identity/organizations")).json<{ id: string }[]>().map((o) => o.id);
    expect(everywhere).toEqual(expect.arrayContaining([addis, south]));
    expect((await finance.identity("GET", `/api/identity/organizations/${south}`)).statusCode).toBe(200);

    // org:read holders keep working; neither permission: 403
    const onboarding = await createStaff(h);
    await grant(onboarding.id, "ONBOARDING_OFFICER", "addis-ababa");
    expect((await onboarding.identity("GET", "/api/identity/organizations?cityId=addis-ababa&status=VERIFIED")).json<{ id: string }[]>().map((o) => o.id)).toContain(addis);
    const d = await createStaff(h);
    await grant(d.id, "DISPATCHER", "addis-ababa");
    expect((await d.identity("GET", "/api/identity/organizations")).statusCode).toBe(403);
    expect((await d.identity("GET", `/api/identity/organizations/${addis}`)).statusCode).toBe(403);
  });
});

describe("staff self-service (admin surface)", () => {
  it("renames themselves; protected fields aren't writable", async () => {
    const s = await createStaff(h);
    // Better Auth refuses the admin plugin's fields outright and drops our input:false fields
    expect((await s.call("POST", "/api/admin-auth/update-user", { name: "Selam", role: "super_admin" })).statusCode).toBe(400);
    for (const body of [{ name: "Selam", permissionVersion: 0, accountStatus: "GUEST" }, { name: "Selam", mustChangePassword: true }]) {
      expect((await s.call("POST", "/api/admin-auth/update-user", body)).statusCode).toBeLessThan(500);
    }
    expect(await h.c.db.user.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ role: "", permissionVersion: 1, accountStatus: "ACTIVE", mustChangePassword: false });
    const res = await s.call("POST", "/api/admin-auth/update-user", { name: "Selam Tesfaye" });
    expect(res.statusCode, res.body).toBe(200);
    expect((await h.c.db.user.findUniqueOrThrow({ where: { id: s.id } })).name).toBe("Selam Tesfaye");
    expect((await s.call("POST", "/api/admin-auth/update-user", { image: "https://example.com/me.png" })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("new backup codes replace the old ones and sign in without the authenticator; sessions are listed and revoked", async () => {
    const s = await createStaff(h);
    await grant(s.id, "ANALYST", "addis-ababa");
    const gen = await s.call("POST", "/api/admin-auth/two-factor/generate-backup-codes", { password: s.password });
    expect(gen.statusCode, gen.body).toBe(200);
    const codes = gen.json<{ backupCodes: string[] }>().backupCodes;
    expect(codes.length).toBeGreaterThanOrEqual(8);

    // a second device signs in with a backup code instead of the authenticator
    const other = new StaffUser(h, s.id, s.email, s.password);
    const signIn = await other.call("POST", "/api/admin-auth/sign-in/email", { email: s.email, password: s.password });
    expect(signIn.json()).toMatchObject({ twoFactorRedirect: true });
    expect((await other.call("POST", "/api/admin-auth/two-factor/verify-backup-code", { code: "not-a-code" })).statusCode).toBeGreaterThanOrEqual(400);
    const ok = await other.call("POST", "/api/admin-auth/two-factor/verify-backup-code", { code: codes[0] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(claimsOf(await other.accessToken()).roles).toEqual([{ r: "ANALYST", city: "addis-ababa" }]);

    // each code works once
    const third = new StaffUser(h, s.id, s.email, s.password);
    await third.call("POST", "/api/admin-auth/sign-in/email", { email: s.email, password: s.password });
    expect((await third.call("POST", "/api/admin-auth/two-factor/verify-backup-code", { code: codes[0] })).statusCode).toBeGreaterThanOrEqual(400);

    const sessions = await s.call("GET", "/api/admin-auth/list-sessions");
    expect(sessions.statusCode, sessions.body).toBe(200);
    expect(sessions.json<unknown[]>().length).toBeGreaterThanOrEqual(2);
    const revoke = await s.call("POST", "/api/admin-auth/revoke-other-sessions", {});
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect((await other.call("GET", "/api/admin-auth/token")).statusCode).toBe(401);
    expect((await s.call("GET", "/api/admin-auth/token")).statusCode).toBe(200);
  });
});

describe("approvals inbox: city-aware", () => {
  it("city-scoped request/approve holders see and decide their city's requests only; global holders see all", async () => {
    await hawassa();
    // a city role that may ask for and approve staff role grants in its city
    const created = await superA.identity("POST", "/api/identity/authz/changes", {
      create: { label: "City grant desk", storage: "city" }, set: [{ permission: "role:request", scope: "C" }, { permission: "role:approve", scope: "C" }],
      reason: "city offices grant their own staff roles",
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((await approve(superB, created.json<{ id: string }>().id)).statusCode).toBe(200);
    const deskA = await createStaff(h);
    const deskB = await createStaff(h);
    const deskSouth = await createStaff(h);
    await grant(deskA.id, "CUSTOM_CITY_GRANT_DESK", "addis-ababa");
    await grant(deskB.id, "CUSTOM_CITY_GRANT_DESK", "addis-ababa");
    await grant(deskSouth.id, "CUSTOM_CITY_GRANT_DESK", "hawassa");

    const target = await createStaff(h);
    // a city holder asks in its own city only; global roles need a global grant
    expect((await deskA.identity("POST", "/api/identity/staff-role-requests", { userId: target.id, role: "ANALYST", cityId: "hawassa", reason: "not my city to grant" })).statusCode).toBe(403);
    expect((await deskA.identity("POST", "/api/identity/staff-role-requests", { userId: target.id, role: "FINANCE_OFFICER", reason: "a global role from a city desk" })).statusCode).toBe(403);
    const asked = await deskA.identity("POST", "/api/identity/staff-role-requests", { userId: target.id, role: "ANALYST", cityId: "addis-ababa", reason: "reports for the Addis office" });
    expect(asked.statusCode, asked.body).toBe(201);
    const id = asked.json<{ id: string; cityId: string }>().id;
    expect(asked.json()).toMatchObject({ cityId: "addis-ababa" });
    // a platform-wide request (no city) that only global holders see
    const globalReq = await superA.identity("POST", "/api/identity/staff-role-requests", { userId: target.id, role: "AUDITOR", reason: "internal audit cover this quarter" });
    expect(globalReq.statusCode, globalReq.body).toBe(201);
    const globalId = globalReq.json<{ id: string }>().id;

    const inbox = async (who: StaffUser) => {
      const r = await who.identity("GET", "/api/identity/approvals?status=PENDING");
      expect(r.statusCode, r.body).toBe(200);
      return r.json<{ approvals: { id: string }[] }>().approvals.map((a) => a.id);
    };
    expect(await inbox(deskB)).toContain(id);
    expect(await inbox(deskB)).not.toContain(globalId);
    expect(await inbox(deskSouth)).not.toContain(id);
    expect(await inbox(superB)).toEqual(expect.arrayContaining([id, globalId]));

    // deciding needs the permission in the request's city, and a different person
    expect((await approve(deskSouth, id)).statusCode).toBe(403);
    expect((await deskSouth.identity("POST", `/api/identity/approvals/${id}/reject`, { reason: "another city deciding" })).statusCode).toBe(403);
    expect((await approve(deskB, globalId)).statusCode).toBe(403);
    expect((await approve(deskA, id)).json()).toMatchObject({ error: "maker_is_checker" });
    const ok = await approve(deskB, id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(claimsOf(await target.accessToken()).roles).toEqual(expect.arrayContaining([{ r: "ANALYST", city: "addis-ababa" }]));
    expect((await superB.identity("POST", `/api/identity/approvals/${globalId}/reject`, { reason: "not needed after all" })).statusCode).toBe(200);
  });
});

describe("partner organisations: reinstatement and members", () => {
  async function member(orgId: string, role: string) {
    const u = new AppUser(h, phone());
    const { user } = await u.signIn();
    await h.c.db.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId: user.id, role, createdAt: new Date() } });
    return { u, id: user.id };
  }

  it("org:suspend holders lift a suspension: status restored, roles count again, reason recorded and audited", async () => {
    const orgId = await partnerOrg("addis-ababa");
    const owner = await member(orgId, "fleet_owner");
    const safety = await createStaff(h);
    await grant(safety.id, "SAFETY_OFFICER", "addis-ababa");
    const onboarding = await createStaff(h);
    await grant(onboarding.id, "ONBOARDING_OFFICER", "addis-ababa");

    expect(claimsOf(await owner.u.accessToken()).roles).toEqual(expect.arrayContaining([{ r: "FLEET_OWNER", org: orgId }]));
    expect((await safety.identity("POST", `/api/identity/organizations/${orgId}/reinstate`, { reason: "nothing to lift here yet" })).json()).toMatchObject({ error: "not_suspended" });
    expect((await safety.identity("POST", `/api/identity/organizations/${orgId}/suspend`, { reason: "fraud report under review" })).statusCode).toBe(200);
    expect((await safety.identity("POST", `/api/identity/organizations/${orgId}/suspend`, { reason: "fraud report under review" })).json()).toMatchObject({ error: "already_suspended" });
    expect(claimsOf(await owner.u.accessToken()).roles).not.toEqual(expect.arrayContaining([{ r: "FLEET_OWNER", org: orgId }]));

    // only org:suspend holders lift it (onboarding officers verify, they don't suspend)
    expect((await onboarding.identity("POST", `/api/identity/organizations/${orgId}/reinstate`, { reason: "onboarding trying to lift it" })).statusCode).toBe(403);
    expect((await safety.identity("POST", `/api/identity/organizations/${orgId}/reinstate`, { reason: "short" })).statusCode).toBe(400);
    const before = (await h.c.db.user.findUniqueOrThrow({ where: { id: owner.id } })).permissionVersion;
    const res = await safety.identity("POST", `/api/identity/organizations/${orgId}/reinstate`, { reason: "investigation cleared the company" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ orgId, status: "VERIFIED" });
    expect((await h.c.db.user.findUniqueOrThrow({ where: { id: owner.id } })).permissionVersion).toBe(before + 1);
    expect(claimsOf(await owner.u.accessToken()).roles).toEqual(expect.arrayContaining([{ r: "FLEET_OWNER", org: orgId }]));

    const events = await h.c.db.outbox.findMany({ where: { key: orgId, topic: "org.reinstated" } });
    expect(events.map((e) => e.payload)).toEqual([expect.objectContaining({ orgId, status: "VERIFIED", byUserId: safety.id })]);
    const audits = await h.c.db.outbox.findMany({ where: { topic: "audit.recorded" } });
    expect(audits.some((a) => { const p = a.payload as { action: string; resource: { id: string }; reason?: string }; return p.action === "org:reinstate" && p.resource.id === orgId && p.reason === "investigation cleared the company"; })).toBe(true);

    // a company suspended while waiting goes back to waiting, not verified
    const waiting = await partnerOrg("addis-ababa");
    await h.c.db.organization.update({ where: { id: waiting }, data: { status: "PENDING" } });
    expect((await safety.identity("POST", `/api/identity/organizations/${waiting}/suspend`, { reason: "duplicate registration check" })).statusCode).toBe(200);
    expect((await safety.identity("POST", `/api/identity/organizations/${waiting}/reinstate`, { reason: "not a duplicate after all" })).json()).toEqual({ orgId: waiting, status: "PENDING" });
  });

  it("staff list a company's members with masked phones (org:read or org:suspend in its city)", async () => {
    await hawassa();
    const orgId = await partnerOrg("addis-ababa");
    const owner = await member(orgId, "fleet_owner");
    const driver = await member(orgId, "fleet_driver");
    const safety = await createStaff(h);
    await grant(safety.id, "SAFETY_OFFICER", "addis-ababa");
    const onboarding = await createStaff(h);
    await grant(onboarding.id, "ONBOARDING_OFFICER", "addis-ababa");
    const south = await createStaff(h);
    await grant(south.id, "ONBOARDING_OFFICER", "hawassa");
    const dispatcher = await createStaff(h);
    await grant(dispatcher.id, "DISPATCHER", "addis-ababa");

    for (const who of [safety, onboarding]) {
      const res = await who.identity("GET", `/api/identity/organizations/${orgId}/members`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ members: { userId: string; roles: string[]; phone: string; suspended: boolean }[] }>();
      expect(body.members.map((m) => m.userId)).toEqual([owner.id, driver.id]);
      expect(body.members[1]).toMatchObject({ roles: ["fleet_driver"], suspended: false });
      expect(body.members.every((m) => m.phone.includes("•••"))).toBe(true);
      expect(res.body).not.toContain(owner.u.phone);
    }
    expect((await south.identity("GET", `/api/identity/organizations/${orgId}/members`)).statusCode).toBe(403);
    expect((await dispatcher.identity("GET", `/api/identity/organizations/${orgId}/members`)).statusCode).toBe(403);
    const staffOrg = (await h.c.db.organization.findFirstOrThrow({ where: { kind: "STAFF_CITY", cityId: "addis-ababa" } })).id;
    expect((await superA.identity("GET", `/api/identity/organizations/${staffOrg}/members`)).statusCode).toBe(404);
  });
});
