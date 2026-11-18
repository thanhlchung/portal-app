import { useCallback, useEffect, useRef, useState } from "react";
import { CodeInput } from "../components/CodeInput";
import { authClient, displayNameFromEmail } from "../lib/auth-client";

const RESEND_SECONDS = 60;

/** Matches the server-side OTP expiry in apps/api/src/auth.ts. */
const CODE_TTL_MS = 10 * 60 * 1000;

const PENDING_KEY = "portal.pendingSignIn";

type Step = "email" | "code";

interface PendingSignIn {
  email: string;
  sentAt: number;
}

/**
 * A code is requested, then the user leaves for their mail app.
 *
 * On a phone that is enough to lose the page entirely: iOS discards and
 * relaunches home-screen apps under memory pressure, and a browser tab can be
 * evicted just as easily. Without persisting this, the user returns to a blank
 * email field holding a code they can no longer enter — which is exactly the
 * bug this exists to prevent.
 */
function readPending(): PendingSignIn | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingSignIn;
    if (!parsed?.email || typeof parsed.sentAt !== "number") return null;
    // An expired code is noise: fall back to the email step, keeping the address.
    return Date.now() - parsed.sentAt < CODE_TTL_MS ? parsed : { ...parsed, sentAt: 0 };
  } catch {
    return null;
  }
}

function writePending(email: string): number {
  const sentAt = Date.now();
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ email, sentAt }));
  } catch {
    // Storage can be unavailable or full; the flow still works without it.
  }
  return sentAt;
}

function clearPending(): void {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

const restored = readPending();
const restoredIsLive = Boolean(restored && restored.sentAt > 0);

export default function SignInScreen() {
  const [step, setStep] = useState<Step>(restoredIsLive ? "code" : "email");
  const [email, setEmail] = useState(restored?.email ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(
    restored && restored.sentAt === 0 ? "That code expired — send yourself a new one." : null,
  );
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(() => {
    if (!restoredIsLive || !restored) return 0;
    const elapsed = Math.floor((Date.now() - restored.sentAt) / 1000);
    return Math.max(0, RESEND_SECONDS - elapsed);
  });
  const [mailDelivery, setMailDelivery] = useState<"resend" | "console" | null>(null);

  const submitted = useRef("");
  const [canPaste, setCanPaste] = useState(false);

  // Ask the deployment whether it can actually send email. Without this the
  // screen says "we sent a code" on a deployment that has no mail provider and
  // sends nothing, which reads as a broken app rather than a missing setting.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((config) => {
        if (!cancelled && config?.mailDelivery) setMailDelivery(config.mailDelivery);
      })
      .catch(() => {
        // Non-fatal: fall back to the neutral wording.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Clipboard reads need a permission prompt on iOS, so only offer the control
  // where the API exists at all. The user has just copied the code in Mail; this
  // is the shortest path from "copied" to "signed in".
  useEffect(() => {
    setCanPaste(typeof navigator !== "undefined" && Boolean(navigator.clipboard?.readText));
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const sendCode = useCallback(
    async (address: string) => {
      setError(null);
      setBusy(true);
      const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
        email: address,
        type: "sign-in",
      });
      setBusy(false);

      if (sendError) {
        setError(
          sendError.status === 429
            ? "Too many codes requested. Wait a minute and try again."
            : "We couldn't send that code. Check the address and try again.",
        );
        return false;
      }

      const sentAt = writePending(address);
      setResendIn(Math.max(0, RESEND_SECONDS - Math.floor((Date.now() - sentAt) / 1000)));
      // The API returns success before the mail provider has answered, so give
      // the background send a moment and then check what actually happened.
      void confirmDelivery();
      return true;
    },
    [],
  );

  /**
   * Better Auth sends the code as a background task and reports success even if
   * the provider rejected it (an address the sending domain may not reach, for
   * instance). One follow-up read turns that into a visible error.
   */
  async function confirmDelivery() {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      const response = await fetch("/api/config");
      if (!response.ok) return;
      const config = (await response.json()) as {
        lastDelivery?: { at: string; ok: boolean } | null;
      };
      const outcome = config.lastDelivery;
      if (!outcome) return;
      const age = Date.now() - new Date(outcome.at).getTime();
      if (age < 60_000 && !outcome.ok) {
        setError(
          "The server couldn't deliver that code — this deployment's email sender may not reach that address. Try a different address.",
        );
      }
    } catch {
      // Non-fatal: the resend control is still available.
    }
  }

  async function onSubmitEmail(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    if (!address.includes("@")) {
      setError("Enter an email address.");
      return;
    }
    const ok = await sendCode(address);
    if (ok) {
      setEmail(address);
      setCode("");
      submitted.current = "";
      setStep("code");
    }
  }

  const verify = useCallback(
    async (value: string) => {
      // Guards against the same code being submitted twice (auto-submit plus a
      // stray Enter press, or a re-render during the request).
      if (submitted.current === value) return;
      submitted.current = value;
      setBusy(true);
      setError(null);

      const { error: signInError } = await authClient.signIn.emailOtp({
        email,
        otp: value,
        // Only used when this code creates the account.
        name: displayNameFromEmail(email),
      });

      setBusy(false);

      if (signInError) {
        submitted.current = "";
        setCode("");
        setError(
          signInError.status === 429
            ? "Too many attempts. Wait a minute before trying again."
            : "That code didn't work. Check it and try again, or send a new one.",
        );
        return;
      }

      // Session changed; the root component swaps screens. Clear the resume
      // marker so a later sign-out does not jump back into a stale code step.
      clearPending();
    },
    [email],
  );

  // Auto-submit the moment the sixth digit lands. Removing a tap is the single
  // biggest win in the whole flow.
  useEffect(() => {
    if (step === "code" && code.length === 6 && !busy) {
      void verify(code);
    }
  }, [code, step, busy, verify]);

  return (
    <div className="app">
      <header className="app-header app-header--bare">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Portal</span>
        </div>
      </header>

      <main className="screen screen--center">
        {step === "email" ? (
          <form className="auth" onSubmit={onSubmitEmail} noValidate>
            <h1 className="auth-title">Sign in</h1>
            <p className="auth-sub">
              We&apos;ll email you a six-digit code. No password to remember.
            </p>

            <label className="field">
              <span className="field-label">Email address</span>
              <input
                className="text-input"
                type="email"
                name="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError(null);
                }}
                placeholder="you@example.com"
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                required
                autoFocus
              />
            </label>

            {mailDelivery === "console" ? (
              <p className="field-note">
                Email delivery is not configured on this deployment. The code will be written to
                the server log instead of your inbox.
              </p>
            ) : null}

            {error ? <p className="form-error">{error}</p> : null}

            <button className="button button--primary" type="submit" disabled={busy}>
              {busy ? <span className="button-spinner" aria-hidden="true" /> : null}
              {busy ? "Sending code" : "Email me a code"}
            </button>
          </form>
        ) : (
          <div className="auth">
            <h1 className="auth-title">
              {mailDelivery === "console" ? "Code generated" : "Check your email"}
            </h1>
            <p className="auth-sub">
              {mailDelivery === "console" ? (
                <>
                  No message was sent to <strong className="auth-email">{email}</strong> — this
                  deployment has no email provider. The code is in the server log.
                </>
              ) : (
                <>
                  We sent a code to <strong className="auth-email">{email}</strong>. It expires in
                  10 minutes.
                </>
              )}
            </p>

            <CodeInput value={code} onChange={setCode} disabled={busy} autoFocus />

            {canPaste && code.length < 6 ? (
              <button
                className="link-button"
                type="button"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  try {
                    const text = await navigator.clipboard.readText();
                    const digits = text.replace(/\D/g, "").slice(0, 6);
                    if (digits.length === 6) {
                      setCode(digits); // auto-submits via the effect below
                    } else {
                      setError("Your clipboard doesn't contain a six-digit code.");
                    }
                  } catch {
                    // Permission denied or no clipboard access: typing still works.
                    setError("Couldn't read the clipboard — paste it into the code box instead.");
                  }
                }}
              >
                Paste code from clipboard
              </button>
            ) : null}

            {error ? <p className="form-error">{error}</p> : null}
            {busy && !error ? <p className="auth-hint">Signing you in…</p> : null}

            <button
              className="button button--primary"
              type="button"
              onClick={() => void verify(code)}
              disabled={busy || code.length !== 6}
            >
              Sign in
            </button>

            <div className="auth-actions">
              <button
                className="link-button"
                type="button"
                onClick={() => void sendCode(email)}
                disabled={busy || resendIn > 0}
              >
                {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
              </button>
              <button
                className="link-button"
                type="button"
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError(null);
                  submitted.current = "";
                  clearPending();
                }}
                disabled={busy}
              >
                Use a different email
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
