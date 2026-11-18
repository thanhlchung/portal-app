import { useCallback, useEffect, useRef, useState } from "react";
import { CodeInput } from "../components/CodeInput";
import { authClient, displayNameFromEmail } from "../lib/auth-client";

const RESEND_SECONDS = 60;

type Step = "email" | "code";

export default function SignInScreen() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [mailDelivery, setMailDelivery] = useState<"resend" | "console" | null>(null);

  const submitted = useRef("");

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

      setResendIn(RESEND_SECONDS);
      return true;
    },
    [],
  );

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

      // Session changed; the root component swaps screens. Nothing to do here.
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
