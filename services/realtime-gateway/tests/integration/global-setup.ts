// A throwaway Redis for the integration tests, in its own container on port 6392,
// so tests never touch a Redis you use for anything else (they flush it).
// Set TEST_REDIS_URL to use another *dedicated* instance instead.

import { execFileSync } from "node:child_process";

const CONTAINER = "anbessa-test-redis";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6392";

export default function setup() {
  if (process.env.TEST_REDIS_URL) return;
  const running = execFileSync("docker", ["ps", "-q", "--filter", `name=^${CONTAINER}$`]).toString().trim();
  if (!running) {
    execFileSync("docker", ["run", "--rm", "-d", "--name", CONTAINER, "-p", "6392:6379", "redis:8-alpine"], { stdio: "pipe" });
  }
  return () => {
    if (!running) execFileSync("docker", ["stop", CONTAINER], { stdio: "pipe" });
  };
}
