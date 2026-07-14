import argon2 from "argon2";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { userRepository } from "../repositories/user.repository.js";
import { publishUserCreated } from "../events/producers/user-events.producer.js";
import { AppError } from "../middlewares/error-handler.js";
import { config } from "../config/index.js";

const privateKey = readFileSync(config.JWT_PRIVATE_KEY_PATH);

export const authService = {
  async register(input: { email: string; phone: string; password: string; role: "RIDER" | "DRIVER" }) {
    const existing = await userRepository.findByEmail(input.email);
    if (existing) throw new AppError(409, "Email already registered", "email_taken");

    const passwordHash = await argon2.hash(input.password);
    const user = await userRepository.create({ ...input, passwordHash });
    await publishUserCreated(user.id, user.role);
    return user;
  },

  async login(email: string, password: string) {
    const user = await userRepository.findByEmail(email);
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      throw new AppError(401, "Invalid credentials", "invalid_credentials");
    }

    const accessToken = await new SignJWT({ sub: user.id, role: user.role })
      .setProtectedHeader({ alg: "RS256" })
      .setExpirationTime(config.JWT_ACCESS_TTL)
      .sign(privateKey);

    return { accessToken, user };
  },
};
