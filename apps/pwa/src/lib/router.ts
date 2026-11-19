import { useSyncExternalStore } from "react";

/**
 * Minimal history-API router.
 *
 * The app has three screens and no nesting, so a router dependency would be
 * more surface than the problem deserves. `useSyncExternalStore` is the correct
 * primitive here: the location is external mutable state, and every screen
 * subscribes to the same snapshot.
 *
 * Both production (a `/*` rewrite to index.html) and the Vite dev server serve
 * index.html for unknown paths, so deep links such as /play work directly.
 */

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", notify);
}

/** Normalise `/play/` to `/play` so route comparisons cannot miss. */
function normalise(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "");
  return pathname;
}

export function currentPath(): string {
  return typeof window === "undefined" ? "/" : normalise(window.location.pathname);
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const target = new URL(to, window.location.origin);
  if (
    target.pathname + target.search + target.hash ===
    window.location.pathname + window.location.search + window.location.hash
  ) {
    return;
  }
  if (options.replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => "/");
}

/** Navigate without losing middle-click / ctrl-click semantics. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      navigate(to);
    },
  };
}
