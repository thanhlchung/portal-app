import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { persister, queryClient } from "./lib/query";
import { watchForUpdates } from "./lib/update";
import "./styles.css";

/**
 * Which queries may be written to localStorage.
 *
 * Position payloads never are: a live share is the most sensitive data the app
 * holds, and a persisted cache would keep coordinates on the device for days,
 * past the share's own end. Notes, games and boards are safe to cache for
 * offline-first reads; share metadata is cheap to refetch and is deliberately
 * not persisted either.
 */
const PERSISTED_KEYS = new Set(["notes", "games", "scores"]);

function shouldPersistQuery(query: { queryKey: readonly unknown[] }): boolean {
  return PERSISTED_KEYS.has(String(query.queryKey[0]));
}


/**
 * Ask the browser not to evict this origin's storage.
 *
 * Sign-in does not depend on this — the session lives in an HttpOnly cookie that
 * the server sets. What can be evicted is the cached note list (localStorage),
 * after ~7 days of non-use in Safari (ITP). WebKit's heuristic favours granting
 * persistence to app-like contexts, so asking is worth one silent call.
 */
if (navigator.storage?.persist) {
  void navigator.storage.persist().catch(() => {
    // Non-fatal: an evicted cache costs one refetch, not a sign-out.
  });
}

// The service worker is what makes this an app rather than a website: instant
// repeat launches and a usable shell with no network. Registered in production
// only, because a cached shell during development makes HMR confusing.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("service worker registration failed", error);
    });
  });
}

watchForUpdates();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        // Bump when the shape of a cached response changes, so stale local
        // state from an old deploy is discarded instead of trusted.
        buster: "v2",
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      }}
    >
      <App />
    </PersistQueryClientProvider>
  </StrictMode>,
);
