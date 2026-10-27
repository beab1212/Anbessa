// HTTP idempotency keys (Database.md §9, race 3), as in trip-service: the first request with a key
// does the work and stores the response; a retry gets the stored response; a concurrent duplicate
// gets 409; the same key with a different body gets 422. Failed requests release the key.

import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { AppError } from "./errors.js";

export interface Stored {
  statusCode: number;
  body: unknown;
}

const KEY = /^[A-Za-z0-9_-]{8,100}$/;

export async function withIdempotency(db: Db, userId: string, key: string | undefined, request: unknown, work: () => Promise<Stored>): Promise<Stored> {
  if (key === undefined) return work();
  if (!KEY.test(key)) throw new AppError(400, "Idempotency-Key must be 8–100 characters of [A-Za-z0-9_-]", "bad_request");
  const requestHash = new Uint8Array(createHash("sha256").update(JSON.stringify(request ?? null)).digest());

  try {
    await db.idempotencyKey.create({ data: { userId, key, requestHash } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const existing = await db.idempotencyKey.findUniqueOrThrow({ where: { userId_key: { userId, key } } });
    if (!Buffer.from(existing.requestHash).equals(Buffer.from(requestHash))) {
      throw new AppError(422, "this Idempotency-Key was used with a different request", "idempotency_mismatch");
    }
    if (existing.status !== "DONE") throw new AppError(409, "the same request is still in progress", "request_in_progress");
    return { statusCode: existing.statusCode ?? 200, body: existing.response };
  }

  try {
    const result = await work();
    await db.idempotencyKey.update({
      where: { userId_key: { userId, key } },
      data: { status: "DONE", statusCode: result.statusCode, response: result.body as Prisma.InputJsonValue },
    });
    return result;
  } catch (err) {
    await db.idempotencyKey.delete({ where: { userId_key: { userId, key } } }).catch(() => undefined);
    throw err;
  }
}

export async function purgeIdempotencyKeys(db: Db, now: Date, olderThanHours = 24) {
  const { count } = await db.idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - olderThanHours * 3_600_000) } } });
  return count;
}
