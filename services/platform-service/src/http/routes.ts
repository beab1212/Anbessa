// platform-service HTTP API, under /api/platform (one Kong route). Staff (ride-admin) tokens for
// everything except the public client configuration.

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { unauthorized } from "../lib/errors.js";
import type { CatalogService } from "../catalog/service.js";
import type { SettingsService } from "../settings/service.js";
import type { SystemHealth } from "../system/health.js";

/** A query flag: "true"/"1" is on; anything else, "false" included, is off (z.coerce.boolean() reads "false" as true). */
const queryFlag = z.enum(["true", "false", "1", "0"]).default("false").transform((v) => v === "true" || v === "1");


const uuid = z.string().uuid();
const reason = z.string().trim().min(5).max(500);
const cityIdParam = z.string().regex(/^[a-z0-9-]{1,40}$/);
const AUDIENCES = ["rider", "driver", "partner", "staff"] as const;

export interface RouteDeps {
  db: Db;
  settings: SettingsService;
  catalog: CatalogService;
  system: SystemHealth;
  verifyAccessToken: VerifyAccessToken;
  internalToken: string;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { settings, catalog, system } = deps;

  async function staff(req: FastifyRequest): Promise<Principal> {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    return deps.verifyAccessToken(token, "ride-admin");
  }

  // ── public ────────────────────────────────────────────────────────────────
  // Staff-audience announcements are internal: they come back only with a valid staff (ride-admin)
  // token. Anyone else (no token, a rider or driver token) gets the public audiences only.
  app.get("/api/platform/client-config", async (req, reply) => {
    const q = z.object({ audience: z.enum(AUDIENCES).optional(), cityId: cityIdParam.optional() }).parse(req.query);
    const token = bearerToken(req.headers.authorization);
    const isStaff = token ? await deps.verifyAccessToken(token, "ride-admin").then(() => true, () => false) : false;
    reply.header("vary", "authorization");
    reply.header("cache-control", isStaff ? "private, no-store" : "public, max-age=15");
    return reply.send(await catalog.clientConfig({ ...q, staff: isStaff }));
  });

  // ── settings ──────────────────────────────────────────────────────────────
  app.get("/api/platform/settings", async (req) => settings.overview(await staff(req)));
  app.get("/api/platform/settings/history", async (req) => {
    const q = z.object({ key: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return { history: await settings.history(await staff(req), q) };
  });
  app.put("/api/platform/settings/:key", async (req, reply) => {
    const { key } = z.object({ key: z.string().max(80) }).parse(req.params);
    const body = z.object({ value: z.unknown(), cityId: cityIdParam.nullable().optional(), reason }).parse(req.body);
    const r = await settings.propose(await staff(req), key, { value: body.value ?? null, cityId: body.cityId ?? null, reason: body.reason });
    return reply.status(r.status === "PENDING_APPROVAL" ? 202 : 200).send(r);
  });
  app.get("/api/platform/settings/changes", async (req) => {
    const q = z.object({ status: z.enum(["PENDING", "EXECUTED", "REJECTED", "EXPIRED", "CANCELLED"]).optional() }).parse(req.query);
    return { changes: await settings.changes(await staff(req), q.status) };
  });
  app.post("/api/platform/settings/changes/:id/approve", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return settings.approve(await staff(req), id, z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {}).reason);
  });
  app.post("/api/platform/settings/changes/:id/reject", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return settings.reject(await staff(req), id, z.object({ reason }).parse(req.body).reason);
  });
  app.post("/api/platform/settings/changes/:id/cancel", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return settings.cancel(await staff(req), id);
  });

  // ── cities and vehicle types ──────────────────────────────────────────────
  const city = z.object({
    name: z.string().trim().min(2).max(80),
    timezone: z.string().trim().min(3).max(60).default("Africa/Addis_Ababa"),
    enabled: z.boolean().default(true),
    bbox: z.object({ minLat: z.number().min(-90).max(90), minLng: z.number().min(-180).max(180), maxLat: z.number().min(-90).max(90), maxLng: z.number().min(-180).max(180) }),
  });
  app.get("/api/platform/cities", async (req) => ({ cities: await catalog.listCities(await staff(req)) }));
  app.post("/api/platform/cities", async (req, reply) => {
    const body = city.extend({ id: cityIdParam }).parse(req.body);
    return reply.status(201).send(await catalog.saveCity(await staff(req), body.id, body, { create: true }));
  });
  app.put("/api/platform/cities/:id", async (req) => {
    const { id } = z.object({ id: cityIdParam }).parse(req.params);
    return catalog.saveCity(await staff(req), id, city.parse(req.body), { create: false });
  });
  app.get("/api/platform/vehicle-types", async (req) => ({ vehicleTypes: await catalog.listVehicleTypes(await staff(req)) }));
  app.put("/api/platform/vehicle-types/:code", async (req) => {
    const { code } = z.object({ code: z.string().max(30) }).parse(req.params);
    const body = z.object({
      name: z.string().trim().min(2).max(40), seatsMin: z.number().int(), seatsMax: z.number().int(), enabled: z.boolean(),
      cities: z.array(cityIdParam).max(50).default([]),
    }).parse(req.body);
    return catalog.saveVehicleType(await staff(req), code, body);
  });

  // ── announcements ─────────────────────────────────────────────────────────
  const announcement = z.object({
    title: z.string().trim().min(3).max(80),
    body: z.string().trim().min(3).max(500),
    severity: z.enum(["info", "warning"]).default("info"),
    audiences: z.array(z.enum(AUDIENCES)).min(1),
    cities: z.array(cityIdParam).max(50).default([]),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date().nullable().optional(),
  });
  app.get("/api/platform/announcements", async (req) => ({ announcements: await catalog.listAnnouncements(await staff(req)) }));
  app.post("/api/platform/announcements", async (req, reply) => reply.status(201).send(await catalog.saveAnnouncement(await staff(req), null, announcement.parse(req.body))));
  app.put("/api/platform/announcements/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return catalog.saveAnnouncement(await staff(req), id, announcement.parse(req.body));
  });
  app.post("/api/platform/announcements/:id/archive", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return catalog.archiveAnnouncement(await staff(req), id);
  });

  // ── system ────────────────────────────────────────────────────────────────
  app.get("/api/platform/system", async (req, reply) => {
    const { refresh } = z.object({ refresh: queryFlag }).parse(req.query);
    return reply.header("cache-control", "no-store").send(await system.check(await staff(req), refresh));
  });

  // ── internal ──────────────────────────────────────────────────────────────
  const internal = (req: FastifyRequest) => {
    const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
    const expected = Buffer.from(deps.internalToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
  };
  // every service loads its settings from here (libs/shared-settings client.ts)
  app.get("/internal/settings/snapshot", async (req) => {
    internal(req);
    return settings.snapshot();
  });
}
