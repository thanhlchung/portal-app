/**
 * In-process rate limits and throttles.
 *
 * A single free Render instance owns one process, so this is sufficient (and
 * cheap) for what it protects: the create endpoint, position reads, and the
 * ping cadence. On a multi-instance plan these limits become per-instance,
 * which is documented rather than hidden — the database invariants remain the
 * real enforcement.
 *
 * Two primitives:
 *
 * - `rateLimit` — a fixed window: N calls per window per key.
 * - `throttle`  — at least `intervalMs` between calls per key.
 *
 * Both return `retryAfterMs` on refusal so routes can set `Retry-After`.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
const gates = new Map<string, number>();
const MAX_TRACKED = 10_000;

function prune(now: number): void {
  if (windows.size <= MAX_TRACKED && gates.size <= MAX_TRACKED) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  for (const [key, last] of gates) {
    if (last <= now - 10 * 60_000) gates.delete(key);
  }
}

export type LimitResult = { ok: true } | { ok: false; retryAfterMs: number };

/** Fixed window: at most `limit` calls per `windowMs` for `key`. */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): LimitResult {
  prune(now);
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (existing.count >= limit) {
    return { ok: false, retryAfterMs: existing.resetAt - now };
  }
  existing.count += 1;
  return { ok: true };
}

/** At least `intervalMs` between calls for `key`. */
export function throttle(key: string, intervalMs: number, now: number = Date.now()): LimitResult {
  prune(now);
  const last = gates.get(key);
  if (last !== undefined && now - last < intervalMs) {
    return { ok: false, retryAfterMs: intervalMs - (now - last) };
  }
  gates.set(key, now);
  return { ok: true };
}

/** Test seam: the module is shared across a process, tests must start clean. */
export function resetLimitsForTests(): void {
  windows.clear();
  gates.clear();
}
