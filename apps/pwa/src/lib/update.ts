/**
 * Stale-build detection.
 *
 * A service worker that caches the app shell can serve an *older* shell when a
 * navigation happens while the network is briefly unavailable — exactly what a
 * phone does when you come back from another app on a sleeping radio. The user
 * then runs last deploy's JavaScript and any bug fixed since appears unfixed.
 *
 * The bundle filename is content-hashed, so it doubles as a build id: compare the
 * one this page is running against the one the server currently advertises, and
 * reload once if they differ.
 *
 * Guarded so a reload can only happen once per session — if detection misfires,
 * the cost is a single refresh, not a loop.
 */

const RELOAD_FLAG = "portal.reloadedForUpdate";

/** The hashed entry bundle this document is actually running. */
function runningBundle(): string | null {
  const script = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="/assets/"]',
  );
  return script?.getAttribute("src") ?? null;
}

/** The bundle the server would hand out right now. */
async function advertisedBundle(): Promise<string | null> {
  const response = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
  if (!response.ok) return null;
  const html = await response.text();
  const match = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/.exec(html);
  return match?.[1] ?? null;
}

let inFlight = false;

export async function reloadIfStale(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    if (sessionStorage.getItem(RELOAD_FLAG) === "1") return;

    const running = runningBundle();
    if (!running) return;

    const advertised = await advertisedBundle();
    if (!advertised || advertised === running) return;

    sessionStorage.setItem(RELOAD_FLAG, "1");
    // Anything the user was part-way through is persisted by the screen itself
    // (see the pending-sign-in record), so a reload here does not lose work.
    window.location.reload();
  } catch {
    // Offline or blocked: try again on the next resume.
  } finally {
    inFlight = false;
  }
}

/**
 * Watch for a new build taking control, and re-check whenever the app is
 * brought back to the foreground — the moment at which a stale shell is both
 * most likely and most damaging.
 */
export function watchForUpdates(): void {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // A new worker activated: it may be serving a different build.
      void reloadIfStale();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reloadIfStale();
  });

  void reloadIfStale();
}
