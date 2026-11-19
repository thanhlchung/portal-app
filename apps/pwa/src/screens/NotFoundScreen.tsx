import { linkProps } from "../lib/router";

/**
 * An unknown game slug is a real answer, not a silent fallback.
 *
 * Before the games hub existed every unrecognised path went to the notes
 * screen, which made a typo'd or retired arcade link look like the portal had
 * simply ignored the request.
 */
export default function NotFoundScreen({ slug }: { slug: string }) {
  return (
    <div className="app">
      <header className="app-header">
        <a className="brand brand--link" {...linkProps("/")}>
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Portal</span>
        </a>
      </header>

      <main className="screen screen--center">
        <div className="empty">
          <p className="empty-title">No game called “{slug}”</p>
          <p className="empty-sub">
            It may have been renamed or not ported yet. The games that do exist are on the
            games screen.
          </p>
          <a className="button button--compact button--primary" {...linkProps("/play")}>
            See the games
          </a>
        </div>
      </main>
    </div>
  );
}
