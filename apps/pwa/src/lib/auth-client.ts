import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

/**
 * Same-origin client: the browser talks to /api/auth on its own origin, which
 * is a Vite proxy in development and a Render static-site rewrite in
 * production. Nothing here knows which one it is talking to.
 */
export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
};

/**
 * Better Auth requires a display name at creation time, and an email-code
 * sign-up has no natural place to ask for one. Deriving it from the address
 * keeps first-run friction at "type email, type code" while still giving the
 * UI something friendly to greet the user with.
 */
export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "there";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  if (!cleaned) return "there";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
