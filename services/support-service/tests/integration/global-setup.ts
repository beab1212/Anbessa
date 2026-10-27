// Recreates the support_service_test database with every migration, and starts this suite's own
// throwaway Redis container on port 6396 (never shared: other suites use 6392, 6394, 6395).
// Needs Docker, unless TEST_REDIS_URL points at a Redis you own.

import { execFileSync } from "node:child_process";
import { createDb } from "../../src/db.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ride:ride@localhost:5432/support_service_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6396";
const REDIS_CONTAINER = "anbessa-test-redis-support";

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
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: "pipe" });

  let started = false;
  if (!process.env.TEST_REDIS_URL) {
    const running = execFileSync("docker", ["ps", "-q", "--filter", `name=^${REDIS_CONTAINER}$`]).toString().trim();
    if (!running) {
      execFileSync("docker", ["run", "--rm", "-d", "--name", REDIS_CONTAINER, "-p", "6396:6379", "redis:8-alpine"], { stdio: "pipe" });
      started = true;
    }
  }
  return () => {
    if (started) execFileSync("docker", ["stop", REDIS_CONTAINER], { stdio: "pipe" });
  };
}
