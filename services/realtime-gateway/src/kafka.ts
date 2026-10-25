// driver.location publisher (workflow 04, step 11). Kafka is the durable side path:
// a failure is logged and counted, and never reaches the socket server or the driver.

import { Kafka, logLevel, type Producer } from "kafkajs";
import type { DriverLocationEvent } from "@ride-app/shared-types";

export interface LocationPublisher {
  publish(event: DriverLocationEvent): void;
  stats(): { published: number; dropped: number };
  stop(): Promise<void>;
}

export function kafkaLocationPublisher(brokers: string[], onError: (err: Error) => void): LocationPublisher {
  const kafka = new Kafka({ clientId: "realtime-gateway", brokers, logLevel: logLevel.WARN });
  const producer: Producer = kafka.producer({ allowAutoTopicCreation: true });
  let connected = false;
  let published = 0;
  let dropped = 0;

  const connect = () =>
    producer.connect().then(
      () => void (connected = true),
      (err: Error) => {
        onError(err);
        setTimeout(connect, 5000); // keep trying in the background
      },
    );
  void connect();
  producer.on(producer.events.DISCONNECT, () => {
    connected = false;
  });

  return {
    publish(event) {
      if (!connected) {
        dropped++;
        return;
      }
      producer
        .send({ topic: "driver.location", acks: 1, messages: [{ key: event.driverId, value: JSON.stringify(event) }] })
        .then(() => void published++)
        .catch((err: Error) => {
          dropped++;
          onError(err);
        });
    },
    stats: () => ({ published, dropped }),
    stop: async () => {
      if (connected) await producer.disconnect();
    },
  };
}

/** Without KAFKA_BROKERS (local development): pings still update Redis. */
export const noopPublisher: LocationPublisher = { publish: () => undefined, stats: () => ({ published: 0, dropped: 0 }), stop: async () => undefined };
