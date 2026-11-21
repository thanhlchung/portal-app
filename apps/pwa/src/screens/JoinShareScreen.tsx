import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppHeader } from "../components/AppHeader";
import { ApiError } from "../lib/api";
import { requestCurrentPosition } from "../lib/location";
import { linkProps, navigate } from "../lib/router";
import { joinShare, previewInvite, setSharing, shareErrorMessage } from "../lib/shares";

/**
 * Landing page for a single-use join link.
 *
 * Before sign-in this route only says "you've been invited" (App swaps in the
 * sign-in screen and keeps the URL). After sign-in, the preview names the
 * inviter and the end time and states the mutual-visibility rule, because that
 * consent is the product (FR-22).
 */
export default function JoinShareScreen({ token }: { token: string }) {
  const previewQuery = useQuery({
    queryKey: ["invite-preview", token],
    queryFn: () => previewInvite(token),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
      failureCount < 2,
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = previewQuery.data;

  async function accept() {
    setBusy(true);
    setError(null);

    // Ask while this tap still counts as the gesture.
    const permission = await requestCurrentPosition();

    try {
      const { share, alreadyMember: wasMember } = await joinShare(token);
      if (!wasMember && permission.ok) {
        try {
          await setSharing(share.id, true);
        } catch {
          // The share screen offers a retry; joining is the important part.
        }
      }
      // The token is a bearer secret; replace it in history rather than leaving
      // it in the address bar and the back stack.
      navigate(`/share/${share.id}`, { replace: true });
    } catch (joinError) {
      setError(shareErrorMessage(joinError));
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <AppHeader active="share" />
      <main className="screen">
        <div className="screen-head">
          <h1 className="screen-title">You&apos;re invited</h1>
          <a className="link-button link-button--muted" {...linkProps("/share")}>
            My shares
          </a>
        </div>

        {previewQuery.isPending ? (
          <div className="skeleton-stack" aria-hidden="true">
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-row" />
          </div>
        ) : previewQuery.isError ? (
          <div className="share-tile">
            <p className="share-callout-title">This link can&apos;t be used</p>
            <p className="share-callout-sub">{shareErrorMessage(previewQuery.error)}</p>
            <p className="field-note">
              Ask the person who sent it for a new link — each link works once and expires with the
              share.
            </p>
            <a className="button button--compact" {...linkProps("/share")}>
              Back to my shares
            </a>
          </div>
        ) : preview?.alreadyMember ? (
          <div className="share-tile">
            <p className="share-callout-title">You&apos;re already in this share</p>
            <p className="share-callout-sub">
              Open it below. Your location stays off until you choose to share it.
            </p>
            <a
              className="button button--primary button--compact"
              {...linkProps(`/share/${preview.share.id}`)}
            >
              Open the share
            </a>
          </div>
        ) : preview ? (
          <div className="share-tile">
            <p className="share-inviter">
              <strong>{preview.inviterName}</strong> wants to share locations
              {preview.remainingMinutes > 0
                ? ` for the next ${preview.remainingMinutes} ${
                    preview.remainingMinutes === 1 ? "minute" : "minutes"
                  }`
                : ""}
              .
            </p>
            <ul className="share-explainer-list">
              <li>You&apos;ll see their location, and they&apos;ll see yours while you&apos;re in.</li>
              <li>The share ends automatically when its time is up.</li>
              <li>You can stop sharing your own location or leave at any time.</li>
              <li>Nothing is recorded, and the link works once.</li>
            </ul>

            {error ? (
              <p className="status-bar" role="alert">
                {error}
              </p>
            ) : null}

            <div className="share-actions">
              <button
                className="button button--primary"
                type="button"
                onClick={() => void accept()}
                disabled={busy}
              >
                {busy ? "Joining…" : "Join the share"}
              </button>
              <a className="button" {...linkProps("/share")}>
                Not now
              </a>
            </div>
            <p className="share-footnote">
              Location permission is asked for next. Saying no still joins you as a viewer.
            </p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
