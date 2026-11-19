import { Suspense } from "react";
import { DEFAULT_GAME, findGame, type GameMeta } from "./games/registry";
import { authClient } from "./lib/auth-client";
import { matchPath, usePath } from "./lib/router";
import GameScoresScreen from "./screens/GameScoresScreen";
import GamesLauncher, { RedirectTo } from "./screens/GamesLauncher";
import NotesScreen from "./screens/NotesScreen";
import NotFoundScreen from "./screens/NotFoundScreen";
import SignInScreen from "./screens/SignInScreen";

/**
 * Route table. Every screen except sign-in needs a session, so the gate lives
 * here rather than in each screen — a new route cannot accidentally ship
 * unauthenticated, matching how the API's own middleware works.
 *
 *   /                       notes
 *   /play                   games hub
 *   /play/<slug>            that game
 *   /play/<slug>/scores     that game's board
 *   /scores                 legacy → default game's board
 *
 * Unknown *games* are reported as such; unknown other paths fall back to notes,
 * so an old bookmark or a stale link still lands somewhere useful.
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

  // Checked before /play/:slug: both match `/play/x/scores`, but only this one
  // is the correct reading of it.
  const boardMatch = matchPath("/play/:slug/scores", path);
  if (boardMatch?.slug) {
    const game = findGame(boardMatch.slug);
    return game ? <GameScoresScreen game={game} /> : <NotFoundScreen slug={boardMatch.slug} />;
  }

  const playMatch = matchPath("/play/:slug", path);
  if (playMatch?.slug) {
    const game = findGame(playMatch.slug);
    if (!game) return <NotFoundScreen slug={playMatch.slug} />;
    return <GameRoute game={game} user={session.user} />;
  }

  if (path === "/play") return <GamesLauncher />;
  if (path === "/scores") return <RedirectTo to={`/play/${DEFAULT_GAME}/scores`} />;

  return <NotesScreen user={session.user} />;
}

/** Each game is a lazy chunk; keep the wait dark rather than showing a form. */
function GameRoute({ game, user }: { game: GameMeta; user: { id: string; email: string; name: string } }) {
  const Game = game.Component;
  return (
    <Suspense
      fallback={
        <div className="play">
          <div className="play-loading" role="status">
            Loading {game.title}…
          </div>
        </div>
      }
    >
      <Game user={user} game={game} />
    </Suspense>
  );
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
