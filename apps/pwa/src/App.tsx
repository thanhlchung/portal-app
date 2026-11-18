import { authClient } from "./lib/auth-client";
import NotesScreen from "./screens/NotesScreen";
import SignInScreen from "./screens/SignInScreen";

export default function App() {
  const { data: session, isPending } = authClient.useSession();

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
