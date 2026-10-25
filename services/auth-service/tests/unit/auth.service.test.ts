import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit tests mock the module boundaries (config, key file, repository, Kafka,
// argon2) and assert on business logic only — no DB, broker or key pair needed.
vi.mock("../../src/config/index.js", () => ({
  config: { JWT_PRIVATE_KEY_PATH: "unused.pem", JWT_ACCESS_TTL: "15m" },
}));
vi.mock("node:fs", () => ({ readFileSync: vi.fn(() => "test-key") }));
vi.mock("../../src/repositories/user.repository.js", () => ({
  userRepository: { findByEmail: vi.fn(), create: vi.fn() },
}));
vi.mock("../../src/events/producers/user-events.producer.js", () => ({
  publishUserCreated: vi.fn(),
}));
vi.mock("argon2", () => ({ default: { hash: vi.fn(), verify: vi.fn() } }));

const { authService } = await import("../../src/services/auth.service.js");
const { userRepository } = await import("../../src/repositories/user.repository.js");
const { publishUserCreated } = await import("../../src/events/producers/user-events.producer.js");
const argon2 = (await import("argon2")).default;

const user = {
  id: "u1",
  email: "a@example.com",
  phone: "+251900000000",
  passwordHash: "hash",
  role: "RIDER" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => vi.clearAllMocks());

describe("authService.login", () => {
  it("rejects an unknown email", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(null);
    await expect(authService.login("nobody@example.com", "pw")).rejects.toMatchObject({
      statusCode: 401,
      code: "invalid_credentials",
    });
  });

  it("rejects a wrong password", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(user);
    vi.mocked(argon2.verify).mockResolvedValue(false);
    await expect(authService.login(user.email, "wrong")).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("authService.register", () => {
  it("refuses an email that is already registered", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(user);
    await expect(
      authService.register({ email: user.email, phone: user.phone, password: "pw", role: "RIDER" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "email_taken" });
    expect(userRepository.create).not.toHaveBeenCalled();
  });

  it("hashes the password, stores the user and publishes user.created", async () => {
    vi.mocked(userRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(argon2.hash).mockResolvedValue("hashed");
    vi.mocked(userRepository.create).mockResolvedValue({ ...user, passwordHash: "hashed" });

    await authService.register({ email: user.email, phone: user.phone, password: "pw", role: "RIDER" });

    expect(userRepository.create).toHaveBeenCalledWith(expect.objectContaining({ passwordHash: "hashed" }));
    expect(publishUserCreated).toHaveBeenCalledWith("u1", "RIDER");
  });
});
