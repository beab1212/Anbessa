// Kafka in (driver and trip events) and out (driver.connection_lost).
// Invalid events are logged and skipped so one bad message can't block a partition.

import { Kafka, logLevel, type Producer } from "kafkajs";
import { kafkaClientConfig } from "@ride-app/shared-utils";
import { v7 as uuidv7 } from "uuid";
import { ZodError } from "zod";
import type { DriverConnectionLostEvent } from "@ride-app/shared-types";
import type { Logger } from "@ride-app/shared-utils";
import { TOPICS, type Topic } from "./handlers.js";

export function createKafka(opts: {
  brokers: string[];
  handlers: Record<Topic, (payload: unknown) => Promise<void>>;
  logger: Logger;
  createTopics?: boolean;
}) {
  const kafka = new Kafka(kafkaClientConfig({ clientId: "location-service", brokers: opts.brokers, logLevel: logLevel.WARN }));
  const consumer = kafka.consumer({ groupId: "location-service" });
  const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });

  return {
    async start() {
      if (opts.createTopics) {
        const admin = kafka.admin();
        await admin.connect();
        const existing = new Set(await admin.listTopics());
        const wanted = [...TOPICS, "driver.connection_lost"].filter((t) => !existing.has(t));
        if (wanted.length) await admin.createTopics({ topics: wanted.map((topic) => ({ topic })), waitForLeaders: true });
        await admin.disconnect();
      }
      await producer.connect();
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
            throw err; // Redis trouble: let kafkajs retry
          }
        },
      });
      opts.logger.info({ topics: TOPICS }, "consuming events");
    },

    async connectionLost(e: Omit<DriverConnectionLostEvent, "eventId" | "version" | "at">) {
      const event: DriverConnectionLostEvent = { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...e };
      await producer.send({ topic: "driver.connection_lost", acks: -1, messages: [{ key: e.driverId, value: JSON.stringify(event) }] });
    },

    async stop() {
      await consumer.disconnect();
      await producer.disconnect();
    },
  };
}
