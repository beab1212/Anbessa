import pino, { Logger, type LoggerOptions } from 'pino';

// Paths whose last segment is a bearer secret: anyone holding the URL can use it,
// so it must never reach a log line. Add new token-in-path routes here.
const SECRET_PATH_PATTERNS: RegExp[] = [
  /^(\/api\/trips\/shared\/)[^/]+/, // share-my-trip link token
  /^(\/t\/)[^/]+/, // the web app's public shared-trip page
];

/**
 * A URL that is safe to log: the query string is dropped (it can carry share
 * tokens, OTP codes, phone numbers and precise coordinates) and token path
 * segments are masked, e.g. /api/trips/shared/abc → /api/trips/shared/[redacted].
 */
export function safeLogUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") return url;
  const q = url.search(/[?#]/);
  let path = q === -1 ? url : url.slice(0, q);
  for (const pattern of SECRET_PATH_PATTERNS) path = path.replace(pattern, "$1[redacted]");
  return q === -1 ? path : `${path}?[redacted]`;
}

interface LoggableRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  id?: string | number;
  ip?: string;
  hostname?: string;
  host?: string;
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string; remotePort?: number };
  raw?: { url?: string };
}

/** Request serializer: method, masked path, ip. No headers, no body, no query. */
export function serializeRequest(req: LoggableRequest | undefined) {
  if (!req || typeof req !== "object") return req;
  return {
    method: req.method,
    url: safeLogUrl(req.url ?? req.originalUrl ?? req.raw?.url),
    ...(req.id !== undefined ? { id: req.id } : {}),
    host: req.hostname ?? req.host ?? (typeof req.headers?.host === "string" ? req.headers.host : undefined),
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
  };
}

/** Response serializer: the status code only (no headers, so no Set-Cookie). */
export function serializeResponse(res: { statusCode?: number } | undefined) {
  if (!res || typeof res !== "object") return res;
  return { statusCode: res.statusCode };
}

// Fields scrubbed wherever they appear one or two levels deep in a log object
// (e.g. { phone }, { body: { otp } }, { user: { password } }).
const SECRET_KEYS = [
  "authorization", "cookie", "set-cookie", "password", "passwordHash", "token", "accessToken", "refreshToken",
  "idToken", "secret", "apiKey", "otp", "otpCode", "smsCode", "verificationCode", "pin", "phone", "phoneNumber",
];

export const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  ...SECRET_KEYS.flatMap((k) => {
    const key = /^[a-zA-Z_$][\w$]*$/.test(k) ? k : `["${k}"]`;
    const dot = key.startsWith("[") ? "" : ".";
    return [key, `*${dot}${key}`];
  }),
];

/** The pino options every service logger uses (exported so tests can log to a buffer). */
export function loggerOptions(serviceName: string, environment: string): LoggerOptions {
  return {
    name: serviceName,
    level: environment === "production" ? "info" : "debug",
    transport: environment === "production" ? undefined : { target: "pino-pretty" },
    serializers: { req: serializeRequest, res: serializeResponse, err: pino.stdSerializers.err },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  };
}

export function createLogger(serviceName: string, environment: string): Logger {
  return pino(loggerOptions(serviceName, environment));
}

export type { Logger };
