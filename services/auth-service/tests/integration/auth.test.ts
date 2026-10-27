import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { phoneToEmail } from "../../src/auth/password.js";
import { AppUser, claimsOf, createHarness, createStaff, INTERNAL_TOKEN, phone, type Harness, type StaffUser } from "./harness.js";

let h: Harness;
let superA: StaffUser;
let superB: StaffUser;
let staffOrgId: string;

beforeAll(async () => {
  h = await createHarness();
  superA = await createStaff(h, { role: "super_admin" });
  superB = await createStaff(h, { role: "super_admin" });
  staffOrgId = (await h.c.db.organization.findFirstOrThrow({ where: { kind: "STAFF_CITY", cityId: "addis-ababa" } })).id;
});
afterAll(() => h?.close());

/** maker (A) requests, checker (B) approves, a staff role for `userId` */
async function grantStaffRole(userId: string, role: string, cityId?: string) {
  const req = await superA.identity("POST", "/api/identity/staff-role-requests", { userId, role, cityId, reason: "integration test grant" });
  expect(req.statusCode, req.body).toBe(201);
  const ok = await superB.identity("POST", `/api/identity/staff-role-requests/${req.json<{ id: string }>().id}/approve`, {});
  expect(ok.statusCode, ok.body).toBe(200);
}

async function staffWithRole(role: string, cityId?: string) {
  const s = await createStaff(h);
  await grantStaffRole(s.id, role, cityId);
  return s;
}

describe("phone sign-in and tokens", () => {
  it("signs up with an OTP and gets a minimal ES256 rider token", async () => {
    const u = new AppUser(h, phone());
    const { user } = await u.signIn();
    const token = await u.accessToken();
    const [header] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({ alg: "ES256" });
    const claims = claimsOf(token);
    expect(claims).toMatchObject({ sub: user.id, aud: "ride-app", roles: [{ r: "RIDER" }], amr: ["otp"] });
    expect(JSON.stringify(claims)).not.toContain(u.phone.slice(4)); // no PII in tokens

    const me = await h.app.inject({ method: "GET", url: "/api/identity/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json()).toMatchObject({ userId: user.id, roles: [{ role: "RIDER", scope: "SELF" }] });
  });

  it("rejects a wrong code and locks the code after too many attempts", async () => {
    const u = new AppUser(h, phone());
    await u.call("POST", "/api/auth/phone-number/send-otp", { phoneNumber: u.phone });
    for (let i = 0; i < 3; i++) {
      const bad = await u.call("POST", "/api/auth/phone-number/verify", { phoneNumber: u.phone, code: "000000" });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    }
    const right = await u.call("POST", "/api/auth/phone-number/verify", { phoneNumber: u.phone, code: h.otps.get(u.phone) });
    expect(right.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("an existing account can't switch its phone number by itself", async () => {
    const u = new AppUser(h, phone());
    await u.signIn();
    const other = phone();
    await u.call("POST", "/api/auth/phone-number/send-otp", { phoneNumber: other });
    const res = await u.call("POST", "/api/auth/phone-number/verify", { phoneNumber: other, code: h.otps.get(other), updatePhoneNumber: true });
    expect(res.statusCode).toBe(400);
  });

  it("refuses non-Ethiopian and malformed numbers", async () => {
    const u = new AppUser(h, "+15551234567");
    const res = await u.call("POST", "/api/auth/phone-number/send-otp", { phoneNumber: u.phone });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("users can't grant themselves roles or flip protected fields", async () => {
    const u = new AppUser(h, phone());
    const { user } = await u.signIn();
    await u.call("POST", "/api/auth/update-user", { role: "super_admin", permissionVersion: 0, accountStatus: "ACTIVE", banned: false, name: "Abebe" });
    const row = await h.c.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.role).toBe("rider");
    expect(claimsOf(await u.accessToken()).roles).toEqual([{ r: "RIDER" }]);
  });

  it("a profile photo is a small JPEG data URL; anything else is refused", async () => {
    const u = new AppUser(h, phone());
    const { user } = await u.signIn();
    const small = `data:image/jpeg;base64,${"/9j/4AAQ".repeat(64)}`;
    expect((await u.call("POST", "/api/auth/update-user", { image: small })).statusCode).toBe(200);
    expect((await h.c.db.user.findUniqueOrThrow({ where: { id: user.id } })).image).toBe(small);
    expect((await u.call("POST", "/api/auth/update-user", { image: "https://example.com/me.png" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await u.call("POST", "/api/auth/update-user", { image: `data:image/jpeg;base64,${"A".repeat(60 * 1024)}` })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await h.c.db.user.findUniqueOrThrow({ where: { id: user.id } })).image).toBe(small);
    // other services see it (trip-service shows it to the other side of a trip)
    const internal = await h.app.inject({ method: "GET", url: `/internal/users/${user.id}`, headers: { authorization: `Bearer ${h.c.config.INTERNAL_SERVICE_TOKEN}` } });
    expect(internal.json()).toMatchObject({ id: user.id, image: small });
  });

  it("an app access token is rejected by staff APIs (audience)", async () => {
    const u = new AppUser(h, phone());
    await u.signIn();
    const res = await h.app.inject({ method: "GET", url: "/api/identity/staff-role-requests", headers: { authorization: `Bearer ${await u.accessToken()}` } });
    expect(res.statusCode).toBe(401);
  });

  it("an app session can't mint admin tokens", async () => {
    const u = new AppUser(h, phone());
    await u.signIn();
    const res = await h.app.inject({ method: "GET", url: "/api/admin-auth/token", headers: { authorization: `Bearer ${u.session}`, cookie: `anb-admin.session_token=${u.session}` } });
    expect(res.statusCode).not.toBe(200);
  });
});

describe("endpoint lockdown", () => {
  it.each([
    ["/api/auth/admin/set-role", { userId: "x", role: "super_admin" }],
    ["/api/auth/admin/impersonate-user", { userId: "x" }],
    ["/api/auth/sign-up/email", { email: "a@b.c", password: "x".repeat(12), name: "x" }],
    ["/api/admin-auth/sign-up/email", { email: "a@b.c", password: "x".repeat(12), name: "x" }],
    ["/api/admin-auth/admin/set-role", { userId: "x", role: "super_admin" }],
    ["/api/admin-auth/two-factor/disable", { password: "x" }],
    ["/api/auth/organization/delete", { organizationId: "x" }],
  ])("POST %s is not served", async (url, payload) => {
    const res = await h.app.inject({ method: "POST", url, payload });
    expect(res.statusCode).toBe(404);
  });

  it("app users can't touch staff organisations through Better Auth", async () => {
    const u = new AppUser(h, phone());
    await u.signIn();
    for (const [method, url, body] of [
      ["POST", "/api/auth/organization/set-active", { organizationId: staffOrgId }],
      ["GET", `/api/auth/organization/list-members?organizationId=${staffOrgId}`, undefined],
      ["POST", "/api/auth/organization/invite-member", { organizationId: staffOrgId, email: "x@y.z", role: "dispatcher" }],
    ] as const) {
      const res = await u.call(method, url, body);
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("the internal API needs the service token", async () => {
    const res = await h.app.inject({ method: "POST", url: `/internal/drivers/${superA.id}/role`, payload: { active: true }, headers: { authorization: "Bearer nope" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("staff sign-in", () => {
  it("withholds staff roles until the initial password is changed and TOTP is enrolled", async () => {
    const created = await superA.identity("POST", "/api/identity/staff-accounts", { email: "new.agent@anbessa.test", name: "New Agent" });
    expect(created.statusCode, created.body).toBe(201);
    const { userId, temporaryPassword } = created.json<{ userId: string; temporaryPassword: string }>();
    await grantStaffRole(userId, "SUPPORT_AGENT", "addis-ababa");

    const { StaffUser } = await import("./harness.js");
    const s = new StaffUser(h, userId, "new.agent@anbessa.test", temporaryPassword);
    expect((await s.call("POST", "/api/admin-auth/sign-in/email", { email: s.email, password: temporaryPassword })).statusCode).toBe(200);
    expect(claimsOf(await s.accessToken())).toMatchObject({ roles: [], setup: { twoFactor: true, changePassword: true } });

    const changed = await s.call("POST", "/api/admin-auth/change-password", { currentPassword: temporaryPassword, newPassword: "A-much-better-passw0rd" });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(claimsOf(await s.accessToken())).toMatchObject({ roles: [], setup: { twoFactor: true, changePassword: false } });
  });

  it("a staff account can't sign in to the phone app", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: { email: superA.email, password: superA.password } });
    expect(res.statusCode).toBe(404);
  });
});

describe("maker–checker staff role grants", () => {
  it("the maker can't approve their own request", async () => {
    const s = await createStaff(h);
    const req = await superA.identity("POST", "/api/identity/staff-role-requests", { userId: s.id, role: "DISPATCHER", cityId: "addis-ababa", reason: "covering night shift" });
    const self = await superA.identity("POST", `/api/identity/staff-role-requests/${req.json<{ id: string }>().id}/approve`, {});
    expect(self.statusCode).toBe(403);
    expect(claimsOf(await s.accessToken()).roles).toEqual([]);
  });

  it("an approved grant shows up in the next token, scoped to the city, and bumps pv", async () => {
    const s = await createStaff(h);
    const before = claimsOf(await s.accessToken()).pv;
    await grantStaffRole(s.id, "DISPATCHER", "addis-ababa");
    const claims = claimsOf(await s.accessToken());
    expect(claims.roles).toEqual([{ r: "DISPATCHER", city: "addis-ababa" }]);
    expect(claims.pv).toBeGreaterThan(before);
    expect(h.mem.pv.get(s.id)).toBe(claims.pv);
  });

  it("non-super-admins can't request grants; customer roles aren't grantable", async () => {
    const dispatcher = await staffWithRole("DISPATCHER", "addis-ababa");
    const res = await dispatcher.identity("POST", "/api/identity/staff-role-requests", { userId: dispatcher.id, role: "SUPER_ADMIN", reason: "trying to escalate" });
    expect(res.statusCode).toBe(403);
    const rider = await superA.identity("POST", "/api/identity/staff-role-requests", { userId: dispatcher.id, role: "RIDER", reason: "not a staff role at all" });
    expect(rider.statusCode).toBe(400);
  });

  it("refuses to revoke a super admin when fewer than two would remain", async () => {
    // the rule counts every super admin on the platform: this file's database holds exactly superA and superB
    expect(await h.c.db.user.count({ where: { role: { contains: "super_admin" } } })).toBe(2);
    const res = await superA.identity("POST", "/api/identity/staff-roles/revoke", { userId: superB.id, role: "SUPER_ADMIN", reason: "trying to lock others out" });
    expect(res.statusCode).toBe(409);
  });

  it("an older token is refused after a role change (permission version)", async () => {
    const s = await createStaff(h);
    await grantStaffRole(s.id, "ANALYST", "addis-ababa");
    const old = await s.accessToken();
    await grantStaffRole(s.id, "MARKETING", "addis-ababa");
    const res = await h.app.inject({ method: "GET", url: "/api/identity/me", headers: { authorization: `Bearer ${old}`, "x-auth-surface": "admin" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "token_outdated" });
  });
});

describe("call center guests", () => {
  it("an agent creates a guest; the rider later claims the same account with an OTP", async () => {
    const agent = await staffWithRole("CALL_CENTER_AGENT", "addis-ababa");
    const number = phone();
    const res = await agent.identity("POST", "/api/identity/guests", { phoneNumber: number, cityId: "addis-ababa" });
    expect(res.statusCode, res.body).toBe(201);
    const { userId } = res.json<{ userId: string }>();

    const again = await agent.identity("POST", "/api/identity/guests", { phoneNumber: number, cityId: "addis-ababa" });
    expect(again.json()).toMatchObject({ userId, created: false });

    const { user } = await new AppUser(h, number).signIn();
    expect(user.id).toBe(userId);
    expect((await h.c.db.user.findUniqueOrThrow({ where: { id: userId } })).accountStatus).toBe("ACTIVE");
  });

  it("agents of another city can't create guests here", async () => {
    await h.c.db.city.upsert({ where: { id: "hawassa" }, create: { id: "hawassa", name: "Hawassa", timezone: "Africa/Addis_Ababa" }, update: {} });
    await h.c.db.organization.upsert({
      where: { slug: "staff-hawassa" },
      create: { id: crypto.randomUUID(), name: "Staff Hawassa", slug: "staff-hawassa", kind: "STAFF_CITY", cityId: "hawassa", status: "VERIFIED", createdAt: new Date() },
      update: {},
    });
    const agent = await staffWithRole("CALL_CENTER_AGENT", "hawassa");
    const res = await agent.identity("POST", "/api/identity/guests", { phoneNumber: phone(), cityId: "addis-ababa" });
    expect(res.statusCode).toBe(403);
  });
});

describe("suspension", () => {
  it("a safety officer suspends a rider: sessions die, tokens are refused, new tokens can't be minted", async () => {
    const officer = await staffWithRole("SAFETY_OFFICER", "addis-ababa");
    const rider = new AppUser(h, phone());
    const { user } = await rider.signIn();
    const token = await rider.accessToken();

    const res = await officer.identity("POST", `/api/identity/users/${user.id}/suspend`, { reason: "reported for harassment", cityId: "addis-ababa" });
    expect(res.statusCode, res.body).toBe(200);

    const me = await h.app.inject({ method: "GET", url: "/api/identity/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json()).toMatchObject({ error: "token_revoked" });
    expect((await rider.call("GET", "/api/auth/token")).statusCode).not.toBe(200);
    expect((await rider.signIn().then(() => rider.call("GET", "/api/auth/token")).catch(() => ({ statusCode: 403 }))).statusCode).not.toBe(200);

    const back = await officer.identity("POST", `/api/identity/users/${user.id}/reinstate`, { reason: "investigation closed, no fault", cityId: "addis-ababa" });
    expect(back.statusCode, back.body).toBe(200);
    await rider.signIn();
    expect(claimsOf(await rider.accessToken()).roles).toEqual([{ r: "RIDER" }]);
  });

  it("only super admins suspend staff; nobody suspends themselves", async () => {
    const officer = await staffWithRole("SAFETY_OFFICER", "addis-ababa");
    const target = await staffWithRole("DISPATCHER", "addis-ababa");
    const byOfficer = await officer.identity("POST", `/api/identity/users/${target.id}/suspend`, { reason: "trying to suspend staff", cityId: "addis-ababa" });
    expect(byOfficer.statusCode).toBe(403);
    const self = await superA.identity("POST", `/api/identity/users/${superA.id}/suspend`, { reason: "suspending myself", cityId: "addis-ababa" });
    expect(self.statusCode).toBe(403);
  });
});

describe("partner organisations", () => {
  it("fleet: self-service create (pending) → onboarding verifies → owner invites a driver by phone → driver joins", async () => {
    const owner = new AppUser(h, phone());
    await owner.signIn();
    const create = await owner.call("POST", "/api/auth/organization/create", {
      name: "Selam Fleet", slug: `selam-${Date.now()}`, kind: "FLEET", cityId: "addis-ababa", legalName: "Selam Transport PLC", tin: "0012345678",
      status: "VERIFIED", // ignored: input:false
    });
    expect(create.statusCode, create.body).toBe(200);
    const org = create.json<{ id: string }>();
    expect((await h.c.db.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("PENDING");
    expect(claimsOf(await owner.accessToken()).roles).toContainEqual({ r: "FLEET_OWNER", org: org.id });

    const driverPhone = phone();
    const early = await owner.call("POST", "/api/auth/organization/invite-member", { organizationId: org.id, email: phoneToEmail(driverPhone), role: "fleet_driver" });
    expect(early.statusCode).toBeGreaterThanOrEqual(400); // not verified yet

    const officer = await staffWithRole("ONBOARDING_OFFICER", "addis-ababa");
    const queue = await officer.identity("GET", "/api/identity/organizations?cityId=addis-ababa&status=PENDING");
    expect(queue.json<{ id: string }[]>().map((o) => o.id)).toContain(org.id);
    const verified = await officer.identity("POST", `/api/identity/organizations/${org.id}/verify`, {});
    expect(verified.statusCode, verified.body).toBe(200);

    const smuggle = await owner.call("POST", "/api/auth/organization/invite-member", { organizationId: org.id, email: phoneToEmail(phone()), role: "super_admin" });
    expect(smuggle.statusCode).toBeGreaterThanOrEqual(400);

    const invite = await owner.call("POST", "/api/auth/organization/invite-member", { organizationId: org.id, email: phoneToEmail(driverPhone), role: "fleet_driver" });
    expect(invite.statusCode, invite.body).toBe(200);
    const outbox = await h.c.db.outbox.findFirst({ where: { topic: "org.member_invited" }, orderBy: { createdAt: "desc" } });
    expect(outbox?.payload).toMatchObject({ phoneNumber: driverPhone });

    const driver = new AppUser(h, driverPhone);
    await driver.signIn();
    const invites = await driver.call("GET", "/api/auth/organization/list-user-invitations");
    const inv = invites.json<{ id: string }[]>()[0]!;
    const accept = await driver.call("POST", "/api/auth/organization/accept-invitation", { invitationId: inv.id });
    expect(accept.statusCode, accept.body).toBe(200);
    expect(claimsOf(await driver.accessToken()).roles).toContainEqual({ r: "FLEET_DRIVER", org: org.id });
  });

  it("company accounts: the creator becomes the admin; a TIN can't be registered twice", async () => {
    const admin = new AppUser(h, phone());
    await admin.signIn();
    const create = await admin.call("POST", "/api/auth/organization/create", {
      name: "Abay Bank", slug: `abay-${Date.now()}`, kind: "CORPORATE", cityId: "addis-ababa", legalName: "Abay Bank S.C.", tin: "0055443322",
    });
    expect(create.statusCode, create.body).toBe(200);
    const org = create.json<{ id: string }>();
    expect(claimsOf(await admin.accessToken()).roles).toContainEqual({ r: "CORPORATE_ADMIN", org: org.id });

    const other = new AppUser(h, phone());
    await other.signIn();
    const dup = await other.call("POST", "/api/auth/organization/create", {
      name: "Copycat", slug: `copy-${Date.now()}`, kind: "CORPORATE", cityId: "addis-ababa", legalName: "Copycat", tin: "0055443322",
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json()).toMatchObject({ message: "a company with this TIN is already registered" });
    expect(await h.c.db.organization.count({ where: { tin: "0055443322" } })).toBe(1);
  });

  it("org owners can't change protected organisation fields", async () => {
    const owner = new AppUser(h, phone());
    await owner.signIn();
    const create = await owner.call("POST", "/api/auth/organization/create", {
      name: "Abay Fleet", slug: `abay-${Date.now()}`, kind: "FLEET", cityId: "addis-ababa", legalName: "Abay PLC", tin: "0098765432",
    });
    const org = create.json<{ id: string }>();
    const res = await owner.call("POST", "/api/auth/organization/update", { organizationId: org.id, data: { kind: "STAFF_CITY" } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("nobody can create a staff organisation through Better Auth", async () => {
    const u = new AppUser(h, phone());
    await u.signIn();
    const res = await u.call("POST", "/api/auth/organization/create", {
      name: "Rogue", slug: `rogue-${Date.now()}`, kind: "STAFF_CITY", cityId: "addis-ababa", legalName: "Rogue", tin: "0011223344",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("driver role (internal)", () => {
  it("onboarding service grants and removes the driver role", async () => {
    const u = new AppUser(h, phone());
    const { user } = await u.signIn();
    const headers = { authorization: `Bearer ${INTERNAL_TOKEN}`, "x-service-name": "onboarding" };
    const on = await h.app.inject({ method: "POST", url: `/internal/drivers/${user.id}/role`, headers, payload: { active: true } });
    expect(on.statusCode, on.body).toBe(200);
    expect(claimsOf(await u.accessToken()).roles).toEqual(expect.arrayContaining([{ r: "DRIVER" }, { r: "RIDER" }]));
    await h.app.inject({ method: "POST", url: `/internal/drivers/${user.id}/role`, headers, payload: { active: false } });
    expect(claimsOf(await u.accessToken()).roles).toEqual([{ r: "RIDER" }]);
  });
});

describe("contact lookup (internal)", () => {
  const headers = { authorization: `Bearer ${INTERNAL_TOKEN}`, "x-service-name": "notification-service" };

  it("returns a rider's phone number for SMS campaigns, without the placeholder email", async () => {
    const u = new AppUser(h, phone());
    const { user } = await u.signIn();
    const res = await h.app.inject({ method: "GET", url: `/internal/users/${user.id}/contact`, headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ userId: user.id, phoneNumber: u.phone, email: null });
  });

  it("a user without a phone number gets phoneNumber null and their real email", async () => {
    const res = await h.app.inject({ method: "GET", url: `/internal/users/${superA.id}/contact`, headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ userId: superA.id, phoneNumber: null, email: superA.email });
  });

  it("404 for an unknown user, 400 for a malformed id, 401 without the service token", async () => {
    const unknown = await h.app.inject({ method: "GET", url: `/internal/users/${crypto.randomUUID()}/contact`, headers });
    expect(unknown.statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/internal/users/not-a-uuid/contact", headers })).statusCode).toBe(400);
    const noToken = await h.app.inject({ method: "GET", url: `/internal/users/${superA.id}/contact`, headers: { authorization: "Bearer nope" } });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.body).not.toContain("@");
  });
});
