import type { Logger } from "@ride-app/shared-utils";
import { createLogger } from "@ride-app/shared-utils";
import { config } from "../config/index.js";

export const logger: Logger = createLogger("auth-service", config.NODE_ENV as "production" | "development");
