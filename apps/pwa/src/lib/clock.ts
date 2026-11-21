import { useEffect, useRef, useState } from "react";

/**
 * A clock that follows the *server's* time, anchored to the `serverTime` the
 * payload carries. Rendering countdowns from `Date.now()` alone is wrong on a
 * phone whose clock is minutes off; rendering them from a frozen server time is
 * wrong the other way (the countdown never moves).
 *
 * Re-anchors whenever a newer serverTime arrives (each poll), and ticks once a
 * second so the countdown looks alive between polls.
 */
export function useServerNow(serverTime: string | null | undefined): number {
  const [, setTick] = useState(0);
  const state = useRef<{ iso: string | null; base: number; anchoredAt: number }>({
    iso: null,
    base: Date.now(),
    anchoredAt: Date.now(),
  });

  if (serverTime && state.current.iso !== serverTime) {
    const parsed = Date.parse(serverTime);
    if (!Number.isNaN(parsed)) {
      state.current = { iso: serverTime, base: parsed, anchoredAt: Date.now() };
    }
  }

  useEffect(() => {
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);

  return state.current.base + (Date.now() - state.current.anchoredAt);
}
