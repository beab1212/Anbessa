import { execFileSync } from "node:child_process";
import { createDb } from "../../src/db.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ride:ride@localhost:5432/auth_service_test";

/** Recreate the test database and apply every migration, exactly as production does. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`refusing to recreate "${name}": test database names must end in _test`);

  const maintenance = new URL(TEST_DATABASE_URL);
  maintenance.pathname = "/postgres";
  const db = createDb(maintenance.toString());
  try {
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await db.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await db.$disconnect();
  }

  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
