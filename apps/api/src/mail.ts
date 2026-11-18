/**
 * Outbound email.
 *
 * Deliberately HTTPS-only: Render blocks outbound SMTP (port 25 for every
 * service, and 465/587 as well on free instances), so an SMTP client would
 * work locally and fail in production. Resend's REST API is one fetch call and
 * has no such restriction.
 *
 * With no RESEND_API_KEY set, the code is printed to the server log instead of
 * sent, so the whole flow is testable with zero third-party signup.
 */
export interface OtpEmail {
  to: string;
  code: string;
  expiresInMinutes: number;
}

export interface SendResult {
  delivered: "resend" | "console";
}

/**
 * Test seam. Integration tests need the code that was generated, and it must
 * not be recoverable from the database (`storeOTP: "hashed"`). Observers are
 * additive and do nothing in production, where nobody subscribes.
 */
export type OtpObserver = (email: string, code: string) => void;
const observers = new Set<OtpObserver>();

export function observeOtpSends(observer: OtpObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Whether real email is configured for this deployment.
 *
 * The sign-in flow is identical either way, but the *user-facing* consequence
 * is not: without credentials nobody receives a code. Exposing this lets the
 * client say so instead of claiming an email was sent.
 */
export function mailDeliveryMode(): "resend" | "console" {
  return process.env.RESEND_API_KEY && process.env.MAIL_FROM ? "resend" : "console";
}

export async function sendOtpEmail({ to, code, expiresInMinutes }: OtpEmail): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;

  for (const observer of observers) observer(to, code);

  if (!apiKey || !from) {
    // Local dev / preview: no credentials, so surface the code where the
    // developer is already looking.
    console.log(
      `\n  ┌─ dev OTP ────────────────────────────────\n` +
        `  │  to:   ${to}\n` +
        `  │  code: ${code}\n` +
        `  │  ttl:  ${expiresInMinutes} min\n` +
        `  └──────────────────────────────────────────\n`,
    );
    return { delivered: "console" };
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Your sign-in code: ${code}`,
      // The subject carries the code so it is visible in a notification
      // preview without opening the message — the single biggest win for
      // OTP completion rate on a phone.
      text: `Your sign-in code is ${code}. It expires in ${expiresInMinutes} minutes.\n\nIf you didn't request it, you can ignore this email.`,
      html: renderOtpHtml(code, expiresInMinutes),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "<no body>");
    throw new Error(`resend ${response.status}: ${detail.slice(0, 500)}`);
  }

  return { delivered: "resend" };
}

function renderOtpHtml(code: string, expiresInMinutes: number): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;">
      <tr><td style="font-size:15px;color:#3f3f46;padding-bottom:8px;">Your sign-in code</td></tr>
      <tr><td style="font-size:40px;font-weight:700;letter-spacing:10px;color:#18181b;padding:12px 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${code}</td></tr>
      <tr><td style="font-size:14px;color:#71717a;line-height:1.5;">Enter this code in the app. It expires in ${expiresInMinutes} minutes and can only be used once.</td></tr>
      <tr><td style="font-size:13px;color:#a1a1aa;line-height:1.5;padding-top:24px;border-top:1px solid #e4e4e7;">If you didn't ask to sign in, you can safely ignore this email — nobody can get in without this code.</td></tr>
    </table>
  </body>
</html>`;
}
