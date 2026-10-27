// The two Better Auth surfaces over one identity database (Auth.md AU3, §6):
//   app   → /api/auth        phone OTP, bearer sessions, aud=ride-app,   15-min JWTs
//   admin → /api/admin-auth  password + TOTP, cookies,   aud=ride-admin, 10-min JWTs

import { APIError } from "better-auth/api";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, bearer, jwt, organization, phoneNumber, twoFactor } from "better-auth/plugins";
import { v7 as uuidv7 } from "uuid";
import type { Config } from "../config/index.js";
import type { Db } from "../db.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { globalAc, globalRoles, orgAc, orgRoles } from "./access-control.js";
import { createClaimsBuilder } from "./claims.js";
import { createOrganizationHooks } from "./hooks.js";
import type { OtpSender } from "./otp-delivery.js";
import { ETHIOPIAN_MOBILE, passwordHasher, phoneToEmail } from "./password.js";

/** the profile photo: 48 KB of base64 plus the data-URL prefix */
const PROFILE_IMAGE_MAX_CHARS = 48 * 1024 + 32;

export interface AuthDeps {
  config: Config;
  db: Db;
  otp: OtpSender;
  secondaryStorage?: BetterAuthOptions["secondaryStorage"];
}

const DAY = 60 * 60 * 24;

function shared(deps: AuthDeps, surface: "app" | "admin") {
  const { config, db } = deps;
  return {
    appName: "Anbessa",
    baseURL: config.AUTH_BASE_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: "postgresql" }),
    secondaryStorage: deps.secondaryStorage,
    telemetry: { enabled: false },
    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: surface === "app" ? "anb" : "anb-admin",
      useSecureCookies: config.NODE_ENV === "production",
      defaultCookieAttributes: { sameSite: surface === "admin" ? "strict" : "lax", httpOnly: true },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    user: {
      additionalFields: {
        accountStatus: { type: "string", defaultValue: "ACTIVE", input: false },
        permissionVersion: { type: "number", defaultValue: 0, input: false },
        mustChangePassword: { type: "boolean", defaultValue: false, input: false },
      },
    },
    rateLimit: {
      enabled: config.AUTH_RATE_LIMIT === "on",
      storage: deps.secondaryStorage ? "secondary-storage" : "memory",
      window: 60,
      max: 60,
      customRules: {
        "/phone-number/send-otp": { window: 60, max: 3 },
        "/phone-number/verify": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 5 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/token": { window: 60, max: 30 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; accountStatus?: string }) => {
            await writeOutbox(db, { topic: "user.created", key: user.id, payload: { userId: user.id, guest: user.accountStatus === "GUEST" } });
          },
        },
        update: {
          // the profile photo is a small JPEG data URL the app resized (≤ 48 KB); anything else is refused
          before: async (data: { image?: string | null }) => {
            if (data.image !== undefined && data.image !== null && data.image !== "") {
              if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data.image) || data.image.length > PROFILE_IMAGE_MAX_CHARS) {
                throw new APIError("BAD_REQUEST", { message: "image must be a JPEG data URL of at most 48 KB" });
              }
            }
            return { data };
          },
        },
      },
      session: {
        create: {
          after: async (session: { userId: string; surface?: string; ipAddress?: string | null; userAgent?: string | null }) => {
            // staff sign-ins are audited (Auth.md §13); rider sign-ins are too many and not privileged
            if (surface !== "admin") return;
            await writeOutbox(db, audit({
              actorId: session.userId, action: "staff:sign_in", resource: { type: "user", id: session.userId }, outcome: "ALLOWED",
              reason: [session.ipAddress, session.userAgent?.slice(0, 120)].filter(Boolean).join(" · ") || undefined,
            }));
          },
        },
      },
      account: {
        update: {
          after: async (account: { userId: string; providerId: string; password?: string | null }) => {
            // first password change clears the "must change password" flag set for new staff accounts
            if (account.providerId === "credential" && account.password) {
              await db.user.updateMany({ where: { id: account.userId, mustChangePassword: true }, data: { mustChangePassword: false } });
            }
          },
        },
      },
    },
  } satisfies Partial<BetterAuthOptions>;
}

const adminPlugin = () =>
  admin({ ac: globalAc, roles: globalRoles, defaultRole: "rider", adminRoles: ["super_admin"], allowImpersonatingAdmins: false });

const jwtPlugin = (deps: AuthDeps, surface: "app" | "admin") =>
  jwt({
    disableSettingJwtHeader: true,
    jwks: { keyPairConfig: { alg: "ES256" }, rotationInterval: 90 * DAY, gracePeriod: 30 * DAY },
    jwt: {
      issuer: deps.config.AUTH_ISSUER,
      audience: surface === "app" ? "ride-app" : "ride-admin",
      expirationTime: surface === "app" ? "15m" : "10m",
      definePayload: createClaimsBuilder(deps.db, surface) as never,
    },
  });

export function createAppAuth(deps: AuthDeps) {
  const base = shared(deps, "app");
  return betterAuth({
    ...base,
    basePath: "/api/auth",
    trustedOrigins: deps.config.APP_TRUSTED_ORIGINS,
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 30 * DAY,
      updateAge: DAY,
      // Redis is the fast path; the database copy is what the admin directory lists (sessions, last sign-in)
      storeSessionInDatabase: true,
      additionalFields: { surface: { type: "string", defaultValue: "app", input: false } },
    },
    plugins: [
      phoneNumber({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        requireVerification: true,
        phoneNumberValidator: (p) => ETHIOPIAN_MOBILE.test(p),
        // not awaited (Better Auth advice): avoids slow responses and timing leaks
        sendOTP: ({ phoneNumber: phone, code }) => {
          void deps.otp.send({ phoneNumber: phone, code, ttlSeconds: 300, purpose: "sign_in" });
        },
        signUpOnVerification: { getTempEmail: phoneToEmail, getTempName: (p) => p },
        callbackOnVerification: async ({ user, phoneNumber: phone }) => {
          const u = user as { id: string; email: string; emailVerified: boolean; accountStatus?: string };
          void deps.otp.verified(phone); // best effort, never blocks sign-in
          // a call-center guest becomes a full account by verifying the same phone (workflow 10)
          const claim = u.accountStatus === "GUEST";
          // the placeholder email is derived from the phone just verified, so it's verified too
          // (Better Auth requires a verified email to list and accept organisation invitations)
          const verifyEmail = !u.emailVerified && u.email === phoneToEmail(phone);
          if (!claim && !verifyEmail) return;
          await deps.db.$transaction(async (tx) => {
            await tx.user.update({
              where: { id: u.id },
              data: { ...(claim ? { accountStatus: "ACTIVE" } : {}), ...(verifyEmail ? { emailVerified: true } : {}) },
            });
            if (claim) await writeOutbox(tx, { topic: "user.claimed", key: u.id, payload: { userId: u.id } });
          });
          // Better Auth puts this same object into the new session
          if (claim) u.accountStatus = "ACTIVE";
          if (verifyEmail) u.emailVerified = true;
        },
      }),
      bearer(),
      jwtPlugin(deps, "app"),
      organization({
        ac: orgAc,
        roles: orgRoles,
        creatorRole: "fleet_owner", // becomes corporate_admin for CORPORATE orgs in beforeAddMember
        allowUserToCreateOrganization: async (user) => !(user as { banned?: boolean }).banned,
        disableOrganizationDeletion: true,
        invitationExpiresIn: 7 * DAY,
        membershipLimit: 5000,
        sendInvitationEmail: async () => {
          // delivery happens from the org.member_invited outbox event (SMS for phone-only users)
        },
        schema: {
          organization: {
            additionalFields: {
              kind: { type: "string", required: true, input: true },
              cityId: { type: "string", required: true, input: true },
              legalName: { type: "string", required: false, input: true },
              tin: { type: "string", required: false, input: true },
              status: { type: "string", required: false, defaultValue: "PENDING", input: false },
            },
          },
          member: { additionalFields: { validUntil: { type: "date", required: false, input: false } } },
        },
        organizationHooks: createOrganizationHooks(deps.db) as never,
      }),
      adminPlugin(),
    ],
  });
}

export function createAdminAuth(deps: AuthDeps) {
  const base = shared(deps, "admin");
  return betterAuth({
    ...base,
    basePath: "/api/admin-auth",
    trustedOrigins: deps.config.ADMIN_TRUSTED_ORIGINS,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true, // staff accounts are created by super admins via /api/identity
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: passwordHasher,
    },
    session: {
      expiresIn: DAY / 2, // 12 h
      updateAge: 60 * 60,
      // Redis is the fast path; the database copy is what the admin directory lists (sessions, last sign-in)
      storeSessionInDatabase: true,
      additionalFields: { surface: { type: "string", defaultValue: "admin", input: false } },
    },
    plugins: [jwtPlugin(deps, "admin"), twoFactor({ issuer: "Anbessa" }), adminPlugin()],
  });
}

export type AppAuth = ReturnType<typeof createAppAuth>;
export type AdminAuth = ReturnType<typeof createAdminAuth>;
