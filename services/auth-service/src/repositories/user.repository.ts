import { PrismaClient, type User } from "@prisma/client";

const prisma = new PrismaClient();

export const userRepository = {
  findByEmail: (email: string): Promise<User | null> =>
    prisma.user.findUnique({ where: { email } }),

  create: (data: { email: string; phone: string; passwordHash: string; role: "RIDER" | "DRIVER" }) =>
    prisma.user.create({ data }),
};
