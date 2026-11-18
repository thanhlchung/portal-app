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

/**
 * Outcome of the most recent send.
 *
 * Better Auth executes `sendVerificationOTP` as a background task and swallows
 * the error, so the HTTP response says `{"success":true}` even when the provider
 * rejected the message. Recording the outcome lets `/api/config` tell the client
 * the truth. In-memory by design: this is a single-instance free service, and a
 * restart simply means "no recent outcome", which the client treats as unknown.
 */
export interface DeliveryOutcome {
  at: string;
  ok: boolean;
}

let lastOutcome: DeliveryOutcome | null = null;

export function lastDeliveryOutcome(): DeliveryOutcome | null {
  return lastOutcome;
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

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        // The subject carries the code so it is visible in a notification
        // preview without opening the message — the single biggest win for
        // OTP completion rate on a phone.
        subject: `Your sign-in code: ${code}`,
        text: `Your sign-in code is ${code}. It expires in ${expiresInMinutes} minutes.\n\nIf you didn't request it, you can ignore this email.`,
        html: renderOtpHtml(code, expiresInMinutes),
      }),
    });
  } catch (error) {
    lastOutcome = { at: new Date().toISOString(), ok: false };
    console.error("email send failed (network):", error);
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "<no body>");
    lastOutcome = { at: new Date().toISOString(), ok: false };
    console.error(`email send failed (${response.status}): ${detail.slice(0, 300)}`);
    throw new Error(`resend ${response.status}: ${detail.slice(0, 500)}`);
  }

  lastOutcome = { at: new Date().toISOString(), ok: true };
  return { delivered: "resend" };
}

export function renderOtpHtml(code: string, expiresInMinutes: number): string {
  // Constraints that shape this markup:
  // - Email clients strip JavaScript, so a real copy button is impossible.
  //   The next best thing is a block that is unmistakably a button and easy to
  //   long-press, with the digits contiguous so Gmail's own "Copy code" chip
  //   can detect them. Never split the code across elements, and never put it
  //   in an image — that breaks both detection and copy.
  // - Inline styles and tables only: no <style> block, no web fonts, no images.
  // - The code also appears in the subject and the plain-text part, so a user
  //   who only reads a notification preview never has to open the message.
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px 28px;">
      <tr>
        <td style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#a1a1aa;padding-bottom:18px;">Portal</td>
      </tr>
      <tr>
        <td style="font-size:16px;color:#3f3f46;padding-bottom:18px;">Here is your sign-in code:</td>
      </tr>
      <tr>
        <td align="center" style="padding-bottom:14px;">
          <!-- The copyable affordance. Big, isolated, high contrast, and the six
               digits are one contiguous text run. -->
          <div style="display:inline-block;background:#eef2ff;border:1px solid #c7d2fe;border-radius:16px;padding:20px 30px;">
            <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:40px;font-weight:700;letter-spacing:8px;color:#312e81;line-height:1;">${code}</span>
          </div>
        </td>
      </tr>
      <tr>
        <td align="center" style="font-size:13px;color:#71717a;padding-bottom:26px;">Press and hold the code to copy it</td>
      </tr>
      <tr>
        <td style="font-size:14px;color:#52525b;line-height:1.55;padding-bottom:22px;border-bottom:1px solid #e4e4e7;">
          Enter it in the app to finish signing in. The code expires in ${expiresInMinutes} minutes and can only be used once.
        </td>
      </tr>
      <tr>
        <td style="font-size:13px;color:#a1a1aa;line-height:1.55;padding-top:20px;">
          Didn't try to sign in? You can ignore this email — nobody can get in without this code.
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
