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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
