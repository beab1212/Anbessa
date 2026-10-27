// Kafka handlers that keep campaign_audience: who rides or drives in which city, and when they
// were last active. Registered next to the notification handlers (same consumer group). They
// only upsert a timestamp, so redelivery is harmless.

import type { EventEnvelope, Handler } from "../notify/handlers.js";
import type { CampaignService } from "./service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : undefined);
const city = (v: unknown) => (typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v) ? v : undefined);
const when = (e: EventEnvelope, field?: string) => {
  const raw = field ? e[field] : e.at;
  const d = new Date(typeof raw === "string" ? raw : e.at);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

export const AUDIENCE_TOPICS = ["trip.requested", "trip.completed", "driver.online"] as const;

export function createAudienceHandlers(campaigns: CampaignService): Record<string, Handler> {
  return {
    // trip-service: the rider asked for a trip
    "trip.requested": async (e) => {
      const rider = id(e.riderId);
      const cityId = city(e.cityId);
      if (rider && cityId) await campaigns.seen(rider, "RIDER", cityId, when(e));
    },
    // trip-service: both sides of a finished trip
    "trip.completed": async (e) => {
      const cityId = city(e.cityId);
      if (!cityId) return;
      const at = when(e, "completedAt");
      const rider = id(e.riderId);
      const driver = id(e.driverId);
      if (rider) await campaigns.seen(rider, "RIDER", cityId, at);
      if (driver) await campaigns.seen(driver, "DRIVER", cityId, at);
    },
    // fleet-service: a driving session started
    "driver.online": async (e) => {
      const driver = id(e.driverId);
      const cityId = city(e.cityId);
      if (driver && cityId) await campaigns.seen(driver, "DRIVER", cityId, when(e));
    },
  };
}
