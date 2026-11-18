import { PGlite } from "@electric-sql/pglite";

const db = new PGlite(process.argv[2] ?? ".pglite");
const tables = await db.query<{ tablename: string }>(
  "select tablename from pg_tables where schemaname='public' order by 1",
);
console.log("tables:", tables.rows.map((r) => r.tablename).join(", "));
await db.close();
