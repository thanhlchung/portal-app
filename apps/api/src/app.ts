import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getAuth } from "./auth.js";
import { notesRoutes } from "./routes/notes.js";
import type { AppEnv } from "./types.js";

const allowedOrigins = (
  process.env.TRUSTED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * Single authentication gate for every /api route except the auth endpoints
 * themselves and the health probe.
 *
 * Keeping it in one place means a new route cannot accidentally ship
 * unauthenticated: it is behind the same mount by default.
 */
const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.path.startsWith("/api/auth") || c.req.path === "/api/health") {
    return next();
  }

  const auth = await getAuth();
  const result = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!result) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("user", result.user);
  c.set("session", result.session);
  await next();
};

export const app = new Hono<AppEnv>()
  .use("*", logger())
  .use(
    "/api/*",
    cors({
      origin: (origin) => (origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type"],
    }),
  )
  .use("/api/*", requireSession)

  .get("/api/health", (c) => c.json({ ok: true, uptime: Math.round(process.uptime()) }))

  // Better Auth owns the whole /api/auth subtree: send-code, sign-in, session,
  // sign-out, all of it.
  .on(["GET", "POST"], "/api/auth/*", async (c) => {
    const auth = await getAuth();
    return auth.handler(c.req.raw);
  })

  .get("/api/me", (c) => {
    const user = c.get("user");
    return c.json({
      user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified },
    });
  })

  .route("/api/notes", notesRoutes);

/**
 * The contract the PWA compiles against. `hc<AppType>()` turns this into a
 * typed client, so a breaking change to a route is a type error in the app
 * rather than a runtime surprise.
 */
export type AppType = typeof app;
