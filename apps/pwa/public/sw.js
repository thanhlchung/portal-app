/**
 * Service worker.
 *
 * Strategy, and why:
 * - Navigations: network-first, fall back to the cached shell. A deploy is
 *   picked up immediately when online, and the app still opens offline.
 *
 *   The fallback is a trap worth naming: returning to a backgrounded tab on a
 *   sleeping mobile radio can fail the network fetch and serve a shell from a
 *   *previous* deploy, leaving the user on old JavaScript. The app therefore
 *   compares its own bundle hash against the server's on every resume and
 *   reloads once if they differ (src/lib/update.ts).
 * - Hashed build assets (/assets/*): cache-first. They are immutable.
 * - /api/*: never cached here. The app's own query cache owns offline data,
 *   and caching responses here would risk serving one user's data to the next
 *   person to open the app.
 */

// Bumped whenever the shell changes: a new worker purges the old caches, so a
// returning user cannot be left on a shell that predates a screen's existence
// (/play and /scores arrived with v3; the /play/<slug> hub with v4).
const VERSION = "v4";
const SHELL_CACHE = `portal-shell-${VERSION}`;
const ASSET_CACHE = `portal-assets-${VERSION}`;

const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Same-origin only.
  if (url.origin !== self.location.origin) return;

  // API traffic: hands off.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match("/index.html")) ?? Response.error();
        }),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
