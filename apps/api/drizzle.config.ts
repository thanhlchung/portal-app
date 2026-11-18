import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Only used by drizzle-kit commands that talk to a live database.
  // `drizzle-kit generate` is pure schema -> SQL and needs no connection.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/portal",
  },
  strict: true,
  verbose: true,
});
