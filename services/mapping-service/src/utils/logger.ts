import type { Logger } from "@ride-app/shared-utils";
import { createLogger } from "@ride-app/shared-utils";

export function serviceLogger(nodeEnv: string, level?: string): Logger {
  const logger = createLogger("mapping-service", nodeEnv);
  if (level) logger.level = level;
  return logger;
}
