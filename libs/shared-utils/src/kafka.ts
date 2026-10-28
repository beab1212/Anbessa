import { readFileSync } from "node:fs";

// One place that turns KAFKA_* env vars into kafkajs client options, so every
// service connects the same way. Deliberately free of a kafkajs import: the
// returned object is structurally a kafkajs KafkaConfig, and each service
// passes it straight to `new Kafka(...)`.
//
//   KAFKA_SSL             on | off (default off). TLS to the brokers.
//   KAFKA_SSL_CA          optional path to a PEM CA bundle (implies KAFKA_SSL=on)
//   KAFKA_SASL_MECHANISM  plain | scram-sha-256 | scram-sha-512 (unset = no SASL)
//   KAFKA_SASL_USERNAME   this service's own Kafka principal
//   KAFKA_SASL_PASSWORD   its password (from the secret store, never committed)
//
// With NODE_ENV=production both TLS and SASL are required; the factory throws
// at boot instead of silently connecting in plaintext.

export type KafkaSasl =
  | { mechanism: "plain"; username: string; password: string }
  | { mechanism: "scram-sha-256"; username: string; password: string }
  | { mechanism: "scram-sha-512"; username: string; password: string };

export interface KafkaSecurity {
  ssl?: boolean | { ca: string[] };
  sasl?: KafkaSasl;
}

type Env = Record<string, string | undefined>;

const MECHANISMS = ["plain", "scram-sha-256", "scram-sha-512"] as const;

function flag(name: string, raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return false;
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  throw new Error(`${name} must be on or off`);
}

/** The TLS/SASL part of the kafkajs config, read from env and validated. */
export function kafkaSecurityFromEnv(env: Env = process.env): KafkaSecurity {
  const caPath = env.KAFKA_SSL_CA?.trim();
  const sslOn = flag("KAFKA_SSL", env.KAFKA_SSL) || Boolean(caPath);
  const mechanism = env.KAFKA_SASL_MECHANISM?.trim().toLowerCase();
  const username = env.KAFKA_SASL_USERNAME;
  const password = env.KAFKA_SASL_PASSWORD;

  const out: KafkaSecurity = {};
  if (sslOn) {
    if (caPath) {
      let ca: string;
      try {
        ca = readFileSync(caPath, "utf8");
      } catch {
        throw new Error(`KAFKA_SSL_CA: cannot read the CA bundle at ${caPath}`);
      }
      out.ssl = { ca: [ca] };
    } else {
      out.ssl = true;
    }
  }

  if (mechanism) {
    if (!(MECHANISMS as readonly string[]).includes(mechanism)) {
      throw new Error(`KAFKA_SASL_MECHANISM must be one of ${MECHANISMS.join(", ")}`);
    }
    if (!username || !password) throw new Error("KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required when KAFKA_SASL_MECHANISM is set");
    out.sasl = { mechanism: mechanism as KafkaSasl["mechanism"], username, password };
  } else if (username || password) {
    throw new Error("KAFKA_SASL_USERNAME/KAFKA_SASL_PASSWORD are set but KAFKA_SASL_MECHANISM is not");
  }

  if (env.NODE_ENV === "production") {
    const missing = [!out.ssl && "KAFKA_SSL=on", !out.sasl && "KAFKA_SASL_MECHANISM + KAFKA_SASL_USERNAME + KAFKA_SASL_PASSWORD"].filter(Boolean);
    if (missing.length) throw new Error(`Kafka in production needs TLS and SASL: set ${missing.join(" and ")}`);
  }
  if (out.sasl?.mechanism === "plain" && !out.ssl) {
    // PLAIN sends the password in clear text; only tolerable on a dev box.
    process.emitWarning("KAFKA_SASL_MECHANISM=plain without KAFKA_SSL sends the Kafka password in clear text");
  }
  return out;
}

/**
 * kafkajs client options: the caller's base options (clientId, brokers,
 * logLevel, ...) plus TLS/SASL from env. Usage:
 *   new Kafka(kafkaClientConfig({ clientId: "trip-service", brokers }))
 */
export function kafkaClientConfig<T extends { clientId: string; brokers: string[] }>(base: T, env: Env = process.env): T & KafkaSecurity {
  return { ...base, ...kafkaSecurityFromEnv(env) };
}
