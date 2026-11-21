import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "../lib/auth-client";
import { linkProps } from "../lib/router";

/**
 * The portal header used by the Live Share screens.
 *
 * Notes and Games keep their own hand-written headers; this one exists so the
 * new screens agree on the same set of entry points (and so "Share" is
 * reachable from everywhere, per FR-08).
 */
export function AppHeader({ active }: { active?: "notes" | "share" | "games" }) {
  const queryClient = useQueryClient();
  const link = (current: typeof active) =>
    `link-button link-button--muted${current === active ? " is-active" : ""}`;

  return (
    <header className="app-header">
      <a className="brand brand--link" {...linkProps("/")} aria-label="Portal home">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Portal</span>
      </a>
      <nav className="header-actions" aria-label="Sections">
        <a className={link("notes")} {...linkProps("/")}>
          Notes
        </a>
        <a className={link("share")} {...linkProps("/share")}>
          Share
        </a>
        <a className={link("games")} {...linkProps("/play")}>
          Games
        </a>
        <button
          className="link-button link-button--muted"
          type="button"
          onClick={async () => {
            await authClient.signOut();
            queryClient.clear();
          }}
        >
          Sign out
        </button>
      </nav>
    </header>
  );
}
