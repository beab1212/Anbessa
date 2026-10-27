// Kafka in. trip-service consumes two topics, both for records it keeps alongside trips:
//
//   driver.location   (realtime-gateway, key driverId)   → the GPS trace of trips (src/trips/trace.ts)
//   incident.opened   (support-service, key incidentId)  → regulatory_incident, counted in the
//                                                          regulatory report (src/trips/regulatory.ts)
//
// Consumer group `trip-service`. Invalid events are logged and skipped so one bad message can't
// block a partition; database trouble is thrown so kafkajs retries the message.

import { Kafka, logLevel } from "kafkajs";
import { z, ZodError } from "zod";
import type { Logger } from "@ride-app/shared-utils";
import type { RegulatoryReport } from "../trips/regulatory.js";
import type { TraceRecorder } from "../trips/trace.js";

const id = z.string().uuid();

export const schemas = {
  "driver.location": z.object({
    driverId: id, tripId: id.optional(), cityId: z.string().max(40),
    lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
    heading: z.number().optional(), speed: z.number().optional(), accuracy: z.number().optional(), at: z.number(),
  }),
  "incident.opened": z.object({
    incidentId: id, cityId: z.string().min(1).max(40), category: z.string().min(1).max(40), severity: z.string().min(1).max(20),
    tripId: id.optional(), at: z.string().datetime({ offset: true }),
  }),
};

export type Topic = keyof typeof schemas;
export const TOPICS = Object.keys(schemas) as Topic[];

export function createHandlers(deps: { trace: TraceRecorder; regulatory: RegulatoryReport }): Record<Topic, (payload: unknown) => Promise<void>> {
  return {
    "driver.location": async (payload) => {
      const e = schemas["driver.location"].parse(payload);
      if (e.tripId) await deps.trace.record(e);
    },
    "incident.opened": async (payload) => deps.regulatory.recordIncident(schemas["incident.opened"].parse(payload)),
  };
}

export function createConsumer(opts: { brokers: string[]; handlers: Record<Topic, (payload: unknown) => Promise<void>>; logger: Logger }) {
  const kafka = new Kafka({ clientId: "trip-service", brokers: opts.brokers, logLevel: logLevel.WARN });
  const consumer = kafka.consumer({ groupId: "trip-service" });
  return {
    async start() {
      const admin = kafka.admin();
      await admin.connect();
      const existing = new Set(await admin.listTopics());
      const missing = TOPICS.filter((t) => !existing.has(t));
      if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic })), waitForLeaders: true });
      await admin.disconnect();
      await consumer.connect();
      await consumer.subscribe({ topics: TOPICS });
      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          let payload: unknown;
          try {
            payload = JSON.parse(message.value?.toString() ?? "");
            await opts.handlers[topic as Topic](payload);
          } catch (err) {
            if (err instanceof SyntaxError || err instanceof ZodError) {
              opts.logger.error({ topic, partition, offset: message.offset, err: err.message.slice(0, 300) }, "skipping invalid event");
              return;
            }
            throw err;
          }
        },
      });
      opts.logger.info({ topics: TOPICS }, "consuming events");
    },
    async stop() {
      await consumer.disconnect();
    },
  };
}
