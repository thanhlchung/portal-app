/**
 * Geolocation, wake lock and the publishing loop — the browser-specific half of
 * Live Share, kept out of React and out of the API layer.
 *
 * What the browser can honestly do is foreground-only: a position watcher dies
 * when the page is hidden or the phone locks (see docs/ARCHITECTURE.md §11).
 * This module makes that ceiling explicit rather than pretending otherwise:
 * publishing pauses with the page, the wake lock is released with it, and the
 * server only ever sees pings that actually happened while the user was looking.
 */
import { haversineMeters } from "./geo";

export type GeoPermission = "granted" | "denied" | "prompt" | "unsupported" | "unavailable";

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy: number | null;
}

export type PositionResult =
  | { ok: true; fix: GeoFix }
  | { ok: false; reason: "denied" | "unavailable" | "unsupported" };

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 5_000,
  timeout: 15_000,
};

/** Ask the platform what it already thinks of us, without prompting. */
export async function readGeoPermission(): Promise<GeoPermission> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return "unsupported";
  if (!navigator.permissions) return "prompt";
  try {
    const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    if (status.state === "granted" || status.state === "denied" || status.state === "prompt") {
      return status.state;
    }
    return "prompt";
  } catch {
    // Some engines throw for geolocation queries; the prompt still works.
    return "prompt";
  }
}

/**
 * Ask for one fix. Call it from a user gesture (a button tap): on iOS the
 * permission prompt is a transient-activation behaviour, and losing that turns
 * a working button into a silent failure.
 */
export function requestCurrentPosition(timeoutMs = 15_000): Promise<PositionResult> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve({ ok: false, reason: "unsupported" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          ok: true,
          fix: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: Number.isFinite(position.coords.accuracy)
              ? position.coords.accuracy
              : null,
          },
        }),
      (error) =>
        resolve({ ok: false, reason: error.code === 1 ? "denied" : "unavailable" }),
      { ...GEO_OPTIONS, timeout: timeoutMs },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Publishing loop                                                    */
/* ------------------------------------------------------------------ */

export type PublishOutcome = "ok" | "ended" | "throttled" | "error";
export type PublisherState = "idle" | "watching" | "error" | "ended";

export interface PublisherOptions {
  /** Send one fix. `throttled` is expected and must not surface as an error. */
  publish: (fix: GeoFix) => Promise<PublishOutcome>;
  onState?: (state: PublisherState) => void;
  /** Ten seconds is the product's cadence (FR-09). */
  minIntervalMs?: number;
  /** A significant move publishes immediately, subject to the server throttle. */
  moveThresholdM?: number;
}

export const PUBLISH_INTERVAL_MS = 10_000;
export const PUBLISH_MOVE_THRESHOLD_M = 50;

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

/**
 * Start publishing. Stops on return, when the page hides, and when the server
 * says the share has ended. Safe to call only in a browser.
 */
export function startPublisher(options: PublisherOptions): () => void {
  if (typeof navigator === "undefined" || typeof document === "undefined") {
    options.onState?.("error");
    return () => {};
  }

  const minIntervalMs = options.minIntervalMs ?? PUBLISH_INTERVAL_MS;
  const moveThresholdM = options.moveThresholdM ?? PUBLISH_MOVE_THRESHOLD_M;

  let watchId: number | null = null;
  let wakeLock: WakeLockSentinelLike | null = null;
  let lastPublishAt = 0;
  let lastPoint: { lat: number; lng: number } | null = null;
  let inFlight = false;
  let stopped = false;
  let state: PublisherState = "idle";

  const setState = (next: PublisherState) => {
    if (stopped && next !== "idle" && next !== "ended") return;
    state = next;
    options.onState?.(next);
  };

  function releaseWakeLock(): void {
    const held = wakeLock;
    wakeLock = null;
    void held?.release().catch(() => {});
  }

  async function acquireWakeLock(): Promise<void> {
    if (document.visibilityState !== "visible" || wakeLock) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    try {
      wakeLock = (await navigator.wakeLock.request("screen")) as unknown as WakeLockSentinelLike;
    } catch {
      // Battery saver, older engines, or a permissions policy — the screen
      // simply is not kept awake; the UI already tells the user to keep it open.
    }
  }

  function clearWatch(): void {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  function stopEverything(): void {
    if (stopped) return;
    stopped = true;
    clearWatch();
    releaseWakeLock();
    document.removeEventListener("visibilitychange", onVisibility);
  }

  function publishFix(fix: GeoFix): void {
    if (inFlight || stopped || document.visibilityState !== "visible") return;
    const now = Date.now();
    const moved =
      lastPoint !== null &&
      haversineMeters(lastPoint, { lat: fix.lat, lng: fix.lng }) >= moveThresholdM;
    if (!moved && lastPublishAt !== 0 && now - lastPublishAt < minIntervalMs) return;

    inFlight = true;
    void options
      .publish(fix)
      .then((outcome) => {
        if (stopped) return;
        if (outcome === "ended") {
          stopEverything();
          setState("ended");
          return;
        }
        if (outcome === "ok") {
          lastPublishAt = Date.now();
          lastPoint = { lat: fix.lat, lng: fix.lng };
          setState("watching");
          return;
        }
        if (outcome === "throttled") {
          // The server's five-second floor is expected; retry on a later fix.
          lastPublishAt = Date.now() - minIntervalMs + 1_000;
          return;
        }
        setState("error");
      })
      .catch(() => {
        if (!stopped) setState("error");
      })
      .finally(() => {
        inFlight = false;
      });
  }

  function onPosition(position: GeolocationPosition): void {
    if (stopped || document.visibilityState !== "visible") return;
    publishFix({
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    });
  }

  function onPositionError(error: GeolocationPositionError): void {
    // A denial is final; timeouts and unavailable fixes retry as the watch
    // continues, so they are not treated as state changes.
    if (error.code === error.PERMISSION_DENIED) {
      setState("error");
      stopEverything();
    }
  }

  function startWatch(): void {
    if (stopped || watchId !== null) return;
    if (!navigator.geolocation) {
      setState("error");
      return;
    }
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, GEO_OPTIONS);
    setState("watching");
    void acquireWakeLock();
  }

  function onVisibility(): void {
    if (stopped) return;
    if (document.visibilityState === "visible") {
      startWatch();
    } else {
      // No pings from a hidden page: the browser suspends the watcher anyway,
      // and pretending otherwise would make the freshness contract a lie.
      clearWatch();
      releaseWakeLock();
    }
  }

  document.addEventListener("visibilitychange", onVisibility);
  if (document.visibilityState === "visible") startWatch();

  return () => {
    stopEverything();
    if (state !== "ended") setState("idle");
  };
}
