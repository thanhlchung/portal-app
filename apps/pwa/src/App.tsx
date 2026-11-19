import { authClient } from "./lib/auth-client";
import { usePath } from "./lib/router";
import NotesScreen from "./screens/NotesScreen";
import PlayScreen from "./screens/PlayScreen";
import ScoresScreen from "./screens/ScoresScreen";
import SignInScreen from "./screens/SignInScreen";

/**
 * Three screens, selected by the path. Every one of them except sign-in needs a
 * session, so the gate lives here rather than in each screen — a new route
 * cannot accidentally ship unauthenticated, matching how the API's own
 * middleware works.
 *
 * Unknown paths fall back to notes rather than 404ing: a stale bookmark or a
 * link from an older build should land somewhere useful.
 */
export default function App() {
  const { data: session, isPending } = authClient.useSession();
  const path = usePath();

  // First paint after a cold launch: show the shell, not a spinner, so the app
  // never appears to flash or stall while the session is confirmed.
  if (isPending) {
    return (
      <div className="app">
        <Header />
        <main className="screen">
          <div className="skeleton-stack" aria-hidden="true">
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-row" />
            <div className="skeleton skeleton-row" />
          </div>
        </main>
      </div>
    );
  }

  if (!session) return <SignInScreen />;

  if (path === "/play") return <PlayScreen user={session.user} />;
  if (path === "/scores") return <ScoresScreen />;

  return <NotesScreen user={session.user} />;
}

function Header() {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Portal</span>
      </div>
    </header>
  );
}
