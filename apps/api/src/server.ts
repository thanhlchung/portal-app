import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { runMigrationsSafely } from "./db/migrate.js";

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "0.0.0.0";

if (process.env.RUN_MIGRATIONS_ON_BOOT === "1") {
  // Free Render services cannot use preDeployCommand, so this is how the schema
  // gets created there. On paid plans, prefer `pnpm db:migrate` as the
  // pre-deploy command and leave this off.
  await runMigrationsSafely();
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
  console.log(
    `auth: ${process.env.RESEND_API_KEY ? "resend (https api)" : "console fallback — codes are logged, not emailed"}`,
  );
});

/**
 * Memory heartbeat.
 *
 * A free Render instance has 512 MB and is killed if it exceeds it. Without a
 * periodic sample, an OOM kill leaves no evidence in the logs — you cannot tell
 * a leak (a line climbing every interval) from a plateau (the same number) from
 * a one-off spike. Three lines every five minutes is cheap insurance.
 */
function logMemory(): void {
  const { rss, heapUsed, external } = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 1_048_576);
  console.log(
    `memory rss=${mb(rss)}MB heapUsed=${mb(heapUsed)}MB external=${mb(external)}MB`,
  );
}

logMemory();
// unref so the heartbeat never keeps the process alive.
setInterval(logMemory, 5 * 60 * 1000).unref();


for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
