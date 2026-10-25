// Kafka consumer (group "notification-service"). A handler error leaves the offset
// uncommitted, so kafkajs retries the message; the notifier's dedupe makes that safe.
// Malformed messages are logged and skipped, so one bad event can't block a partition.

import { Kafka, logLevel, type Consumer } from "kafkajs";
import type { Logger } from "@ride-app/shared-utils";
import type { EventEnvelope, Handler } from "./handlers.js";

export function createEventConsumer(opts: {
  brokers: string[];
  handlers: Record<string, Handler>;
  logger: Logger;
  /** dev/test: create missing topics (in production topics are provisioned). */
  createTopics?: boolean;
}) {
  const kafka = new Kafka({ clientId: "notification-service", brokers: opts.brokers, logLevel: logLevel.WARN });
  const consumer: Consumer = kafka.consumer({ groupId: "notification-service" });
  const topics = Object.keys(opts.handlers);

  return {
    async start() {
      if (opts.createTopics) {
        const admin = kafka.admin();
        await admin.connect();
        const existing = new Set(await admin.listTopics());
        const missing = topics.filter((t) => !existing.has(t));
        if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic })), waitForLeaders: true });
        await admin.disconnect();
      }
      await consumer.connect();
      await consumer.subscribe({ topics });
      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          let event: EventEnvelope;
          try {
            event = JSON.parse(message.value?.toString() ?? "");
            if (typeof event.eventId !== "string") throw new Error("missing eventId");
          } catch (err) {
            opts.logger.error({ topic, partition, offset: message.offset, err: (err as Error).message }, "skipping malformed event");
            return;
          }
          await opts.handlers[topic]?.(event);
        },
      });
      opts.logger.info({ topics }, "consuming events");
    },
    stop: () => consumer.disconnect(),
  };
}
