import pino, { Logger } from 'pino';

export function createLogger(serviceName: string, environment: string): Logger {
  return pino({
    name: serviceName,
    level: environment === "production" ? "info" : "debug",
    transport: environment === "production" ? undefined : { target: "pino-pretty" },
  })
}

export type { Logger };
