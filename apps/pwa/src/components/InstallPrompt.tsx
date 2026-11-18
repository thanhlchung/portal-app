import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "portal.install-dismissed";

/**
 * Install affordance.
 *
 * Android/Chrome fires `beforeinstallprompt` and can show a real button. iOS
 * fires nothing and has no install API, so the honest thing is to show the two
 * taps (Share -> Add to Home Screen) instead of pretending.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "1");
  const [isIos, setIsIos] = useState(false);
  const [standalone, setStandalone] = useState(true);

  useEffect(() => {
    const ua = navigator.userAgent;
    const ios = /iphone|ipad|ipod/i.test(ua);
    const standaloneMode =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;

    setIsIos(ios);
    setStandalone(standaloneMode);

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (standalone || dismissed) return null;
  if (!deferred && !isIos) return null;

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  }

  return (
    <div className="install-prompt" role="region" aria-label="Install app">
      <div className="install-copy">
        <strong>Install Portal</strong>
        <span>
          {isIos
            ? "Tap Share, then “Add to Home Screen”."
            : "Add it to your home screen for a full-screen, offline-ready app."}
        </span>
      </div>
      <div className="install-actions">
        {deferred ? (
          <button
            className="button button--compact button--primary"
            type="button"
            onClick={async () => {
              await deferred.prompt();
              await deferred.userChoice;
              setDeferred(null);
            }}
          >
            Install
          </button>
        ) : null}
        <button className="link-button" type="button" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
