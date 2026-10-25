import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type User } from "../generated/prisma/client.js";
import { config } from "../config/index.js";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });

export const userRepository = {
  findByEmail: (email: string): Promise<User | null> =>
    prisma.user.findUnique({ where: { email } }),

  create: (data: { email: string; phone: string; passwordHash: string; role: "RIDER" | "DRIVER" }) =>
    prisma.user.create({ data }),
};
