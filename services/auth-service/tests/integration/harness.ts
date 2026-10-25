// Test harness: the real app (Better Auth + identity API) on a test database,
// driven through Fastify's inject. OTP codes are captured from the console sender,
// and deny/pv signals live in memory instead of Redis.

import { createHmac } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import pino from "pino";
import { decodeJwt } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer, type Container } from "../../src/container.js";
import { passwordHasher } from "../../src/auth/password.js";
import type { SecuritySignals } from "../../src/lib/signals.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

export const INTERNAL_TOKEN = "t".repeat(48);
const APP_ORIGIN = "http://localhost:3000";
const ADMIN_ORIGIN = "http://localhost:5173";

export function memorySignals() {
  const denied = new Set<string>();
  const pv = new Map<string, number>();
  const signals: SecuritySignals = {
    deny: async (id) => void denied.add(id),
    allow: async (id) => void denied.delete(id),
    permissionVersion: async (id, v) => void pv.set(id, v),
    isDenied: async (id) => denied.has(id),
    currentPermissionVersion: async (id) => pv.get(id),
  };
  return { signals, denied, pv };
}

export interface Harness {
  app: FastifyInstance;
  c: Container;
  mem: ReturnType<typeof memorySignals>;
  otps: Map<string, string>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    BETTER_AUTH_SECRET: "s".repeat(64),
    AUTH_BASE_URL: "http://localhost:3001",
    APP_TRUSTED_ORIGINS: APP_ORIGIN,
    ADMIN_TRUSTED_ORIGINS: ADMIN_ORIGIN,
    OTP_DELIVERY: "console",
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
    AUTH_RATE_LIMIT: "off",
  });
  const otps = new Map<string, string>();
  const mem = memorySignals();
  const c = createContainer(config, pino({ level: "silent" }), {
    signals: mem.signals,
    otpSink: (req) => otps.set(req.phoneNumber, req.code),
  });
  const app = await buildApp(c);
  await app.ready();
  return { app, c, mem, otps, close: async () => { await app.close(); await c.close(); } };
}

type Json = Record<string, unknown>;

// ── phone app (bearer sessions) ────────────────────────────────────────────────

export class AppUser {
  constructor(readonly h: Harness, readonly phone: string, public session = "") {}

  async signIn() {
    const send = await this.call("POST", "/api/auth/phone-number/send-otp", { phoneNumber: this.phone });
    if (send.statusCode !== 200) throw new Error(`send-otp ${send.statusCode} ${send.body}`);
    const res = await this.call("POST", "/api/auth/phone-number/verify", { phoneNumber: this.phone, code: this.h.otps.get(this.phone) });
    if (res.statusCode !== 200) throw new Error(`verify ${res.statusCode} ${res.body}`);
    this.session = String(res.headers["set-auth-token"]);
    return res.json() as { user: { id: string } };
  }

  call(method: "GET" | "POST", url: string, body?: Json, headers: Record<string, string> = {}) {
    return this.h.app.inject({
      method, url,
      headers: { origin: APP_ORIGIN, ...(this.session ? { authorization: `Bearer ${this.session}` } : {}), ...headers },
      ...(body ? { payload: body } : {}),
    });
  }

  async accessToken() {
    const res = await this.call("GET", "/api/auth/token");
    if (res.statusCode !== 200) throw new Error(`token ${res.statusCode} ${res.body}`);
    return res.json<{ token: string }>().token;
  }
}

// ── admin dashboard (cookie sessions, password + TOTP) ─────────────────────────

export function totp(secret: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export class StaffUser {
  cookies = new Map<string, string>();
  constructor(readonly h: Harness, readonly id: string, readonly email: string, readonly password: string) {}

  call(method: "GET" | "POST", url: string, body?: Json, headers: Record<string, string> = {}) {
    return this.h.app
      .inject({
        method, url,
        headers: { origin: ADMIN_ORIGIN, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
        ...(body ? { payload: body } : {}),
      })
      .then((res) => {
        const set = res.headers["set-cookie"];
        for (const c of Array.isArray(set) ? set : set ? [set] : []) {
          const [pair] = c.split(";");
          const [k, v] = pair!.split("=");
          if (v) this.cookies.set(k!, v);
          else this.cookies.delete(k!);
        }
        return res;
      });
  }

  async accessToken() {
    const res = await this.call("GET", "/api/admin-auth/token");
    if (res.statusCode !== 200) throw new Error(`admin token ${res.statusCode} ${res.body}`);
    return res.json<{ token: string }>().token;
  }

  /** Bearer call to the identity API with a fresh staff access token. */
  async identity(method: "GET" | "POST", url: string, body?: Json) {
    const token = await this.accessToken();
    return this.h.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  }
}

/**
 * A staff user with the given stored roles (user.role) who has signed in,
 * enrolled TOTP and has a changed password, i.e. a fully set-up admin session.
 */
export async function createStaff(h: Harness, opts: { role?: string; email?: string } = {}): Promise<StaffUser> {
  const id = uuidv7();
  const email = opts.email ?? `staff-${id.slice(-8)}@anbessa.test`;
  const password = `Pw-${id}`;
  await h.c.db.user.create({ data: { id, name: "Test Staff", email, emailVerified: true, role: opts.role ?? "", permissionVersion: 1 } });
  await h.c.db.account.create({
    data: { id: uuidv7(), accountId: id, providerId: "credential", userId: id, password: await passwordHasher.hash(password) },
  });
  const s = new StaffUser(h, id, email, password);
  const signIn = await s.call("POST", "/api/admin-auth/sign-in/email", { email, password });
  if (signIn.statusCode !== 200) throw new Error(`staff sign-in ${signIn.statusCode} ${signIn.body}`);
  const enable = await s.call("POST", "/api/admin-auth/two-factor/enable", { password });
  const uri = new URL(enable.json<{ totpURI: string }>().totpURI);
  const verify = await s.call("POST", "/api/admin-auth/two-factor/verify-totp", { code: totp(uri.searchParams.get("secret")!) });
  if (verify.statusCode !== 200) throw new Error(`verify-totp ${verify.statusCode} ${verify.body}`);
  return s;
}

export const claimsOf = (token: string) => decodeJwt(token) as { sub: string; aud: string; roles: Json[]; pv: number; amr: string[] };

let n = 0;
/** A fresh valid Ethiopian mobile number per call. */
export const phone = () => `+2519${String(Date.now() % 1e4).padStart(4, "0")}${String(n++ % 1e4).padStart(4, "0")}`;
