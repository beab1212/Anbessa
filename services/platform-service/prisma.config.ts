import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 reads the connection URL from here instead of schema.prisma.
// `prisma generate` runs on install without a database, so the URL may be unset.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
