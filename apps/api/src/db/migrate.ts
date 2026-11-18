/**
 * Migration runner.
 *
 * Two entry points, because Render's `preDeployCommand` is only available on
 * paid services:
 *
 * 1. CLI (`pnpm db:migrate`) — the right place to run this on a paid service.
 * 2. Boot time (`RUN_MIGRATIONS_ON_BOOT=1`) — the free-plan equivalent. Drizzle
 *    records applied migrations, so this is a no-op on every start after the
 *    first, and concurrent starts are tolerated rather than fatal.
 */
import { migrate as migrateNodePostgres } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { closeDb, getDb } from "./index.js";

export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

export async function runMigrations(): Promise<void> {
  const db = await getDb();
  // Only touch the PGlite migrator when it is actually the driver in use.
  const migrate = process.env.DATABASE_URL
    ? migrateNodePostgres
    : (await import("drizzle-orm/pglite/migrator")).migrate;
  await migrate(db as never, { migrationsFolder });
}

export async function runMigrationsSafely(): Promise<void> {
  try {
    await runMigrations();
    console.log("database schema up to date");
  } catch (error) {
    // A concurrent instance may have applied the same migration microseconds
    // earlier. That is not a reason to refuse to boot.
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists|duplicate key/i.test(message)) {
      console.warn("migrations already applied by another instance; continuing");
      return;
    }
    throw error;
  }
}

// CLI entry: `tsx src/db/migrate.ts`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMigrations();
  await closeDb();
  console.log(`migrations applied from ${migrationsFolder}`);
  console.log(`driver: ${process.env.DATABASE_URL ? "postgres" : "pglite"}`);
}
