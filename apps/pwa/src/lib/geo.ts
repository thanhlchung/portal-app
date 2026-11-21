/**
 * Pure location helpers: no DOM, no React, no network. Everything the UI says
 * about freshness, distance and time-to-expiry is decided here so it can be
 * unit-tested against a skewed clock instead of only being eyeballed on a phone.
 */

export interface Point {
  lat: number;
  lng: number;
}

export interface Fix extends Point {
  accuracy: number | null;
}

/** Fresh enough to call "Live" without hedging. */
export const FRESH_MS = 45_000;
/** Beyond this the UI must say "last seen", not imply a live position. */
export const STALE_MS = 90_000;
/** A participant is worth drawing a line to only within this range. */
export const MAX_DISTANCE_M = 200;

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function haversineMeters(a: Point, b: Point): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type ParticipantState = "live" | "recent" | "stale" | "paused" | "waiting";

export interface ParticipantLike {
  sharing: boolean;
  lastAt: string | null;
  lat?: number | null;
  lng?: number | null;
}

/**
 * Classify a participant against the *server's* clock (payloads carry
 * `serverTime`), so a device with a wrong clock does not show "last seen in 3
 * hours" for someone who is live.
 */
export function classifyParticipant(
  participant: Pick<ParticipantLike, "sharing" | "lastAt">,
  serverTimeIso: string,
): { state: ParticipantState; ageMs: number | null } {
  if (!participant.sharing) return { state: "paused", ageMs: null };
  if (!participant.lastAt) return { state: "waiting", ageMs: null };

  const serverTime = Date.parse(serverTimeIso);
  const lastAt = Date.parse(participant.lastAt);
  if (Number.isNaN(serverTime) || Number.isNaN(lastAt)) return { state: "waiting", ageMs: null };

  // A clock that claims the future must not read as fresher than now.
  const ageMs = Math.max(0, serverTime - lastAt);
  if (ageMs <= FRESH_MS) return { state: "live", ageMs };
  if (ageMs <= STALE_MS) return { state: "recent", ageMs };
  return { state: "stale", ageMs };
}

/** "8s" / "3m" / "2h" / "1d". */
export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The sentence a participant row shows. Never implies liveness when stale. */
export function describeParticipant(
  participant: ParticipantLike,
  serverTimeIso: string,
): string {
  const { state, ageMs } = classifyParticipant(participant, serverTimeIso);
  if (state === "paused") return "Not sharing";
  if (state === "waiting") return "Waiting for a location fix";
  if (state === "stale") return `Last seen ${formatAge(ageMs ?? 0)} — app may be closed`;
  return `Live · ${formatAge(ageMs ?? 0)} ago`;
}

/** "240 m" / "1.2 km" / "14 km". */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "";
  if (meters < 950) return `${Math.round(meters)} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

/** "12:04" under an hour, "1:12:04" above. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Distance from the viewer to a participant, if both have a fix. */
export function distanceTo(
  viewer: { lat: number; lng: number } | null,
  participant: Pick<ParticipantLike, "lat" | "lng">,
): number | null {
  if (!viewer || participant.lat == null || participant.lng == null) return null;
  return haversineMeters(viewer, { lat: participant.lat, lng: participant.lng });
}
