// Kafka in: location-service's driver.connection_lost ends the driving session (workflow 04 step 14).
// Invalid events are logged and skipped so one bad message can't block a partition.

import { Kafka, logLevel } from "kafkajs";
import { kafkaClientConfig } from "@ride-app/shared-utils";
import { z, ZodError } from "zod";
import type { Logger } from "@ride-app/shared-utils";
import type { FleetService } from "../fleet/service.js";

const connectionLost = z.object({ driverId: z.string().uuid() });

export function createConsumer(opts: { brokers: string[]; fleet: FleetService; logger: Logger }) {
  const kafka = new Kafka(kafkaClientConfig({ clientId: "fleet-service", brokers: opts.brokers, logLevel: logLevel.WARN }));
  const consumer = kafka.consumer({ groupId: "fleet-service" });
  return {
    async start() {
      await consumer.connect();
      await consumer.subscribe({ topics: ["driver.connection_lost"] });
      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            const e = connectionLost.parse(JSON.parse(message.value?.toString() ?? ""));
            await opts.fleet.endSession(e.driverId, "CONNECTION_LOST");
          } catch (err) {
            if (err instanceof SyntaxError || err instanceof ZodError) {
              opts.logger.error({ topic, partition, offset: message.offset }, "skipping invalid event");
              return;
            }
            throw err; // database trouble: let kafkajs retry
          }
        },
      });
    },
    stop: () => consumer.disconnect(),
  };
}
