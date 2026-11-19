/**
 * Display formatting shared by every game screen.
 *
 * Small on purpose — but worth a module: three screens had their own copy of
 * `formatScore`, and the arcade convention (a score always shows at least four
 * digits) has to be the *same* convention on the HUD, the game-over panel and
 * the leaderboard.
 */

/** `7` → `0007`, `12345` → `12345`. Never negative, never fractional. */
export function formatScore(value: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(4, "0");
}

/** "12 Mar" — the year is noise on a board that only holds recent runs. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
}
