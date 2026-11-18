import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { getDb, schema } from "./db/index.js";
import { sendOtpEmail } from "./mail.js";

/** How long a sign-in code stays valid, in seconds. */
export const OTP_EXPIRY_SECONDS = 600;

const DEV_SECRET = "dev-only-secret-not-for-production-use-0123456789";

function trustedOrigins(): string[] {
  const configured = process.env.TRUSTED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured?.length) return configured;
  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}

/**
 * Declared as a function (not inlined into getAuth) so that TypeScript infers
 * the concrete options type. Widening this to `ReturnType<typeof betterAuth>`
 * erases the plugin types and loses the email-OTP methods on `auth.api`.
 */
function makeAuth(db: Awaited<ReturnType<typeof getDb>>) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET must be set in production");
  }

  return betterAuth({
    appName: "Portal",
    secret: secret ?? DEV_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
    basePath: "/api/auth",
    trustedOrigins: trustedOrigins(),
    database: drizzleAdapter(db, { provider: "pg", schema }),

    // Email + password is switched off on purpose: the only way in is a code
    // sent to the address, which keeps the credential surface to one path.
    emailAndPassword: { enabled: false },

    session: {
      // A long-lived session is the whole point of code-based sign-in: the
      // user should not have to fish for another email every time they open
      // the app.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // Signed session cookie cache avoids a database round trip on every
      // request — on a cold mobile connection this is very noticeable.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },

    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: OTP_EXPIRY_SECONDS,
        // Don't store the code in plaintext: a database leak should not hand
        // over live sign-in codes.
        storeOTP: "hashed",
        allowedAttempts: 3,
        // 10 minutes accommodates the real-world detour of switching to a mail
        // app, which the 5-minute default does not.
        resendStrategy: "rotate",
        disableSignUp: false,
        // 3 codes per address per 60s window, on top of Better Auth's global
        // limiter.
        rateLimit: { window: 60, max: 3 },
        async sendVerificationOTP({ email, otp }) {
          // Better Auth runs this as a background task and swallows any throw,
          // so the endpoint still answers {"success":true} when delivery fails.
          // sendOtpEmail records the outcome, which /api/config exposes so the
          // client can report a failure instead of silently pretending.
          await sendOtpEmail({
            to: email,
            code: otp,
            expiresInMinutes: OTP_EXPIRY_SECONDS / 60,
          });
        },
      }),
    ],

    advanced: {
      // Sessions are same-origin in production (the static site rewrites
      // /api/* to this service), so the default Lax policy is correct and
      // keeps the cookie out of cross-site requests.
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
      },
    },
  });
}

export type Auth = ReturnType<typeof makeAuth>;

/** Session shape as Better Auth returns it, including plugin extensions. */
export type AuthSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type AuthUser = AuthSession["user"];
export type AuthSessionData = AuthSession["session"];

let instance: Auth | undefined;

/**
 * Better Auth is constructed lazily because it needs the database handle,
 * which is resolved on first use (see db/index.ts).
 */
export async function getAuth(): Promise<Auth> {
  if (!instance) {
    instance = makeAuth(await getDb());
  }
  return instance;
}
