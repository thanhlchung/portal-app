/**
 * Keyboard-target guards shared by every engine.
 *
 * An engine listens on `window`, so it must not eat keystrokes meant for the
 * shell's nickname field, and must not start a run in the same Enter that
 * presses a focused button. Both games need exactly these rules, so they live
 * here rather than being re-derived per game.
 */

/** Inputs and editable regions: every shortcut is ignored. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Elements that already do something on Enter. The game must not start a new
 * run in the same keystroke that presses "Save score".
 */
export function isActivationTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(target.tagName);
}
