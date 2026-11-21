import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppHeader } from "../components/AppHeader";
import { InstallPrompt } from "../components/InstallPrompt";
import { authClient, type SessionUser } from "../lib/auth-client";
import { useServerNow } from "../lib/clock";
import { formatCountdown } from "../lib/geo";
import { linkProps } from "../lib/router";
import { listShares, shareErrorMessage, type ShareSummary } from "../lib/shares";

/**
 * The hub: active shares, recent ended ones (kept at most 24 hours), the
 * primary "Share location" action, and the display name that other participants
 * will see. The name is editable here because on the sign-in path it is derived
 * from the email address (FR-02).
 */
export default function ShareHubScreen({ user }: { user: SessionUser }) {
  const queryClient = useQueryClient();
  const sharesQuery = useQuery({
    queryKey: ["shares"],
    queryFn: listShares,
    refetchInterval: 15_000,
  });
  const serverNow = useServerNow(sharesQuery.data?.serverTime ?? null);

  const [name, setName] = useState(user.name);
  const [nameNote, setNameNote] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: async (value: string) => {
      const result = await authClient.updateUser({ name: value });
      if (result.error) throw new Error(result.error.message ?? "rename_failed");
      return value;
    },
    onSuccess: (value) => {
      setName(value);
      setNameNote("Saved — people you share with will see this name.");
      setNameError(null);
    },
    onError: () => {
      setNameError("Couldn't save that name. Try again.");
      setNameNote(null);
    },
  });

  const shares = sharesQuery.data?.shares ?? [];
  const active = shares.filter((share) => share.status === "active");
  const ended = shares.filter((share) => share.status === "ended");

  return (
    <div className="app">
      <AppHeader active="share" />
      <InstallPrompt />

      <main className="screen">
        <div className="screen-head">
          <h1 className="screen-title">Live Share</h1>
          <span className="screen-meta">{user.email}</span>
        </div>

        <a className="button button--primary button--compact" {...linkProps("/share/new")}>
          Share my location
        </a>

        <p className="share-lead">
          A share is temporary: pick who can see you and for how long. Nothing is recorded, and either
          side can stop at any moment.
        </p>

        {sharesQuery.isPending ? (
          <div className="skeleton-stack" aria-hidden="true">
            <div className="skeleton skeleton-row" />
            <div className="skeleton skeleton-row" />
          </div>
        ) : sharesQuery.isError ? (
          <p className="status-bar" role="status">
            {shareErrorMessage(sharesQuery.error)}
          </p>
        ) : shares.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No shares yet</p>
            <p className="empty-sub">
              Start one for 30 minutes and send the link to one person. You&apos;ll both see each
              other until it ends.
            </p>
          </div>
        ) : (
          <>
            {active.length > 0 ? (
              <section className="share-section" aria-label="Active shares">
                <h2 className="share-section-title">Live now</h2>
                <ul className="share-list">
                  {active.map((share) => (
                    <ShareCard key={share.id} share={share} serverNow={serverNow} />
                  ))}
                </ul>
              </section>
            ) : null}

            {ended.length > 0 ? (
              <section className="share-section" aria-label="Recent shares">
                <h2 className="share-section-title">Recently ended</h2>
                <ul className="share-list">
                  {ended.map((share) => (
                    <ShareCard key={share.id} share={share} serverNow={serverNow} />
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}

        <section className="share-section" aria-label="Your name">
          <h2 className="share-section-title">Your name in a share</h2>
          <form
            className="share-name-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = name.trim();
              if (value.length < 2) {
                setNameError("Use at least two characters.");
                return;
              }
              rename.mutate(value);
            }}
          >
            <label className="field-label" htmlFor="share-name">
              Display name
            </label>
            <div className="share-name-row">
              <input
                id="share-name"
                className="text-input"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameNote(null);
                  setNameError(null);
                }}
                maxLength={32}
                autoComplete="nickname"
                enterKeyHint="done"
              />
              <button
                className="button button--compact"
                type="submit"
                disabled={rename.isPending || name.trim() === user.name}
              >
                {rename.isPending ? "Saving…" : "Save"}
              </button>
            </div>
            {nameNote ? <p className="field-note">{nameNote}</p> : null}
            {nameError ? (
              <p className="field-note field-note--error" role="status">
                {nameError}
              </p>
            ) : null}
            <p className="field-note">Shown to the people in your share. Your email is never shown.</p>
          </form>
        </section>

        <section className="share-section share-explainer" aria-label="How Live Share works">
          <h2 className="share-section-title">What this does — and doesn&apos;t</h2>
          <ul className="share-explainer-list">
            <li>Everyone you invite sees your location, and you see theirs, while the share is on.</li>
            <li>Updates stop when this app is closed or the phone locks. Keep the screen open.</li>
            <li>When a share ends, its locations are deleted — there is no history to look back at.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}

function ShareCard({ share, serverNow }: { share: ShareSummary; serverNow: number }) {
  const live = share.status === "active";
  const remaining = Math.max(0, Date.parse(share.expiresAt) - serverNow);
  const people = `${share.participantCount} ${share.participantCount === 1 ? "person" : "people"}`;
  const who = share.role === "owner" ? "You started it" : "You're in it";

  return (
    <li>
      <a className="share-card" {...linkProps(`/share/${share.id}`)}>
        <span className={`share-state ${live ? "share-state--live" : "share-state--ended"}`}>
          {live ? "Live" : "Ended"}
        </span>
        <span className="share-card-body">
          <span className="share-card-title">{who}</span>
          <span className="share-card-meta">
            {live
              ? `${people} · ends in ${formatCountdown(remaining)}`
              : `${people} · ended ${formatWhen(share.endedAt ?? share.expiresAt)}`}
          </span>
        </span>
        <span className="share-card-chevron" aria-hidden="true">
          ›
        </span>
      </a>
    </li>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
