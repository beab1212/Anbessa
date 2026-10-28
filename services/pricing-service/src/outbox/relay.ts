import { Kafka, type Producer } from "kafkajs";
import { kafkaClientConfig } from "@ride-app/shared-utils";
import type { Logger } from "@ride-app/shared-utils";
import type { Db } from "../db.js";

// Outbox relay (Database.md §8): publishes committed events to Kafka.
// FOR UPDATE SKIP LOCKED lets several replicas share the work safely.

const BATCH = 100;

export interface OutboxRelay {
  start(): void;
  stop(): Promise<void>;
  /** One pass (used by tests and the shutdown flush). Returns how many rows were published. */
  tick(): Promise<number>;
}

export function createOutboxRelay(db: Db, brokers: string[], logger: Logger, intervalMs = 500): OutboxRelay {
  const kafka = new Kafka(kafkaClientConfig({ clientId: "pricing-service-outbox", brokers }));
  const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  let connected = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick(): Promise<number> {
    if (!connected) {
      await producer.connect();
      connected = true;
    }
    return db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; topic: string; key: string; payload: unknown }[]>`
        SELECT id, topic, key, payload FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return 0;
      for (const row of rows) {
        await producer.send({
          topic: row.topic,
          acks: -1,
          messages: [{ key: row.key, value: JSON.stringify(row.payload) }],
        });
      }
      await tx.outbox.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { publishedAt: new Date() } });
      return rows.length;
    });
  }

  async function loop() {
    if (running) return;
    running = true;
    try {
      while ((await tick()) === BATCH) {
        // drain bursts quickly
      }
    } catch (err) {
      connected = false;
      logger.warn({ err }, "outbox relay: publish failed, will retry");
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      timer = setInterval(() => void loop(), intervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      if (connected) await producer.disconnect().catch(() => undefined);
    },
  };
}
