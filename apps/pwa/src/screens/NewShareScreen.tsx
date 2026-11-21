import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppHeader } from "../components/AppHeader";
import { requestCurrentPosition } from "../lib/location";
import { linkProps, navigate } from "../lib/router";
import {
  createShare,
  recentPeople,
  setSharing,
  shareErrorMessage,
  type InviteView,
} from "../lib/shares";

const DURATIONS: { label: string; minutes: 15 | 30 | 60 | 120 | null }[] = [
  { label: "15 min", minutes: 15 },
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "Until I stop", minutes: null },
];

const OPEN_CAP_MINUTES = 8 * 60;
const PENDING_INVITE_PREFIX = "portal.invites.";

interface PendingInvite extends InviteView {
  forName: string | null;
}

/**
 * Start a share: pick a duration, optionally pick people, confirm what will be
 * shared, then create it. The geolocation request runs first, from this tap, so
 * iOS treats it as user-initiated; a denial still creates the share in
 * see-only mode rather than failing the whole action (FR-06).
 */
export default function NewShareScreen() {
  const recent = useQuery({ queryKey: ["recent-people"], queryFn: recentPeople, retry: 1 });
  const [duration, setDuration] = useState<15 | 30 | 60 | 120 | null>(30);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = recent.data?.people ?? [];
  const minutes = duration ?? OPEN_CAP_MINUTES;
  const endsAt = new Date(Date.now() + minutes * 60_000);
  const endsLabel = endsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function togglePerson(userId: string) {
    setSelected((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId],
    );
  }

  async function start() {
    setBusy(true);
    setError(null);

    // Ask while we still have the tap's activation.
    const permission = await requestCurrentPosition();

    try {
      const { share, invites } = await createShare({
        durationMinutes: duration,
        inviteCount: Math.max(1, selected.length),
      });

      const pending: PendingInvite[] = invites.map((invite, index) => ({
        ...invite,
        forName: people.find((person) => person.userId === selected[index])?.displayName ?? null,
      }));
      try {
        window.sessionStorage.setItem(
          `${PENDING_INVITE_PREFIX}${share.id}`,
          JSON.stringify(pending),
        );
      } catch {
        // Storage can be unavailable; the share still works and links can be
        // regenerated from the share screen.
      }

      if (permission.ok) {
        try {
          await setSharing(share.id, true);
        } catch {
          // Non-fatal: the share screen offers a retry.
        }
      }

      navigate(`/share/${share.id}`);
    } catch (createError) {
      setError(shareErrorMessage(createError));
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <AppHeader active="share" />
      <main className="screen">
        <div className="screen-head">
          <h1 className="screen-title">Start a share</h1>
          <a className="link-button link-button--muted" {...linkProps("/share")}>
            Cancel
          </a>
        </div>

        <section className="share-tile" aria-labelledby="share-duration-label">
          <h2 className="field-label" id="share-duration-label">
            How long
          </h2>
          <div className="share-options" role="group" aria-labelledby="share-duration-label">
            {DURATIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`share-option${duration === option.minutes ? " is-selected" : ""}`}
                aria-pressed={duration === option.minutes}
                onClick={() => setDuration(option.minutes)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="field-note">
            {duration === null
              ? "Runs until you stop it, capped at 8 hours."
              : `Ends automatically at ${endsLabel}.`}
          </p>
        </section>

        <section className="share-tile" aria-labelledby="share-people-label">
          <h2 className="field-label" id="share-people-label">
            Who (optional)
          </h2>
          {recent.isPending ? (
            <div className="skeleton-stack" aria-hidden="true">
              <div className="skeleton skeleton-row" />
            </div>
          ) : people.length === 0 ? (
            <p className="field-note">
              Nobody yet. Start the share and send its link to one person on any app — each link
              works once.
            </p>
          ) : (
            <>
              <div className="share-chips" role="group" aria-labelledby="share-people-label">
                {people.map((person) => (
                  <button
                    key={person.userId}
                    type="button"
                    className={`share-chip${selected.includes(person.userId) ? " is-selected" : ""}`}
                    aria-pressed={selected.includes(person.userId)}
                    onClick={() => togglePerson(person.userId)}
                  >
                    {person.displayName}
                  </button>
                ))}
              </div>
              <p className="field-note">
                Each person you pick gets their own single-use link after you start.
              </p>
            </>
          )}
        </section>

        <section className="share-consent" aria-label="What you are agreeing to">
          <h2 className="share-section-title">Before you start</h2>
          <ul className="share-explainer-list">
            <li>
              People with the link can see your location and you can see theirs, until{" "}
              <strong>{duration === null ? "you stop it (max 8 hours)" : endsLabel}</strong>.
            </li>
            <li>
              Updates stop when this app is closed or the phone locks — keep this screen open while
              you want to be seen.
            </li>
            <li>
              Every link works once, so send each one to one person. Nothing is recorded, and you
              can stop or end the share at any time.
            </li>
          </ul>
        </section>

        {error ? (
          <p className="status-bar" role="alert">
            {error}
          </p>
        ) : null}

        <div className="share-actions">
          <button
            className="button button--primary"
            type="button"
            onClick={() => void start()}
            disabled={busy}
          >
            {busy ? "Starting…" : "Start sharing"}
          </button>
          <button className="button" type="button" onClick={() => navigate("/share")} disabled={busy}>
            Cancel
          </button>
        </div>

        <p className="share-footnote">
          Location permission is asked for next. If you say no, the share still starts and you can
          watch everyone else.
        </p>
      </main>
    </div>
  );
}
