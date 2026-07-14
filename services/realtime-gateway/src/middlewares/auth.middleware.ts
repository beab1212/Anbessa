import type { Socket } from "socket.io";
import { jwtVerify, importSPKI } from "jose";
import { readFileSync } from "node:fs";
import { config } from "../config/index.js";

const publicKeyPem = readFileSync(config.JWT_PUBLIC_KEY_PATH, "utf8");

// Auth happens once at handshake, not on every message — re-verifying a JWT on
// every location ping would add latency to a high-frequency hot path.
export async function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) throw new Error("missing token");
    const key = await importSPKI(publicKeyPem, "RS256");
    const { payload } = await jwtVerify(token, key);
    socket.data.userId = payload.sub;
    socket.data.role = payload.role;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
}
