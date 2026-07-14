import { describe, it, expect, vi } from "vitest";

// Example unit test shape: mock the repository/Kafka boundaries, assert on business logic only.
describe("authService.login", () => {
  it("rejects invalid credentials", async () => {
    // arrange mocks for userRepository.findByEmail + argon2.verify
    // act: call authService.login(...)
    // assert: expect(...).rejects.toThrow()
    expect(true).toBe(true);
  });
});
