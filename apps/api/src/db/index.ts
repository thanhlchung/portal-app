// PGlite and its Drizzle driver are imported lazily inside the dev branch.
// A static import would load a WASM Postgres build into production too, where
// DATABASE_URL always points at a real server — wasted memory on an instance
// that is killed at 512 MB.
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * One Drizzle instance, two drivers.
 *
 * - `DATABASE_URL` set  -> real Postgres (Render Postgres in production).
 * - `DATABASE_URL` unset -> embedded PGlite (Postgres 18 compiled to WASM),
 *   persisted under `.pglite/`. This is what makes `pnpm dev` work on a
 *   machine with no Postgres installed and no cloud account.
 *
 * Both paths use the same migrations, so a local dev database is not a
 * different dialect or a mock — it is Postgres.
 */
export type Database = ReturnType<typeof drizzleNodePostgres<typeof schema>>;

let db: Database | undefined;
let close: (() => Promise<void>) | undefined;

/**
 * TLS is decided by the connection string, not by guesswork about the host.
 *
 * Render hands out two URLs for the same database: an *internal* one that only
 * works inside Render's network and is not TLS, and an *external* one that
 * requires TLS. Forcing `ssl` on the internal URL fails to connect; omitting it
 * on the external URL also fails. So the URL is the source of truth:
 *
 *   no sslmode        -> no TLS (internal, or localhost)
 *   sslmode=disable   -> no TLS
 *   sslmode=no-verify -> TLS, certificate not verified
 *   sslmode=require   -> TLS, verified against the system CA store
 *
 * Set PGSSL_REJECT_UNAUTHORIZED=0 only if a managed database presents a
 * certificate the system store does not know.
 */
function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  const mode = /[?&]sslmode=([a-z-]+)/i.exec(url)?.[1]?.toLowerCase();
  if (!mode || mode === "disable") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  return { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "0" };
}

export async function getDb(): Promise<Database> {
  if (db) return db;

  const url = process.env.DATABASE_URL;

  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: Number(process.env.PG_POOL_MAX ?? 5),
    });
    db = drizzleNodePostgres(pool, { schema }) as unknown as Database;
    close = async () => pool.end();
    return db;
  }

  const [{ PGlite }, { drizzle: drizzlePglite }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
  ]);

  const dataDir = process.env.PGLITE_DIR ?? ".pglite";
  const client = new PGlite(dataDir);
  db = drizzlePglite(client, { schema }) as unknown as Database;
  close = async () => client.close();
  return db;
}

export async function closeDb(): Promise<void> {
  await close?.();
  db = undefined;
  close = undefined;
}

export { schema };
