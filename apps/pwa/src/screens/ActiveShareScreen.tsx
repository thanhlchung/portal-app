import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { AppHeader } from "../components/AppHeader";
import { ApiError } from "../lib/api";
import { useServerNow } from "../lib/clock";
import {
  classifyParticipant,
  describeParticipant,
  distanceTo,
  formatCountdown,
  formatDistance,
} from "../lib/geo";
import {
  readGeoPermission,
  requestCurrentPosition,
  startPublisher,
  type GeoPermission,
  type PublisherState,
} from "../lib/location";
import { linkProps, navigate } from "../lib/router";
import {
  endShare,
  getPositions,
  getShare,
  leaveShare,
  mintInvite,
  publishPosition,
  removeParticipant,
  setSharing,
  shareErrorMessage,
  shareUrl,
  type InviteView,
} from "../lib/shares";

const ShareMap = lazy(() => import("../components/ShareMap"));

const PENDING_INVITE_PREFIX = "portal.invites.";

interface PendingInvite extends InviteView {
  forName: string | null;
}

const EVENT_LABEL: Record<string, string> = {
  created: "started the share",
  joined: "joined",
  left: "left",
  removed: "was removed",
  paused: "stopped sharing their location",
  resumed: "started sharing their location",
  ended: "ended the share",
  expired: "the share expired",
  invite_created: "created an invite link",
};

const PERMISSION_HELP: Record<"denied" | "unavailable" | "unsupported", string> = {
  denied:
    "Location is off for this site. On iPhone: Settings → Privacy & Security → Location Services → Safari (or Portal). On Android: the site settings menu → Permissions → Location. Then try again.",
  unavailable:
    "Your phone couldn't get a location fix. Go somewhere with a clearer view of the sky, or check that Location Services are on, then try again.",
  unsupported: "This browser can't share your location. You can still see everyone else in the share.",
};

/**
 * The active share screen: a list first, a map on demand, and controls that
 * are never more than one tap away. Freshness is always described against the
 * server's clock, and the app stops publishing the moment the page hides — the
 * honest version of what a browser can do.
 */
export default function ActiveShareScreen({ shareId }: { shareId: string }) {
  const queryClient = useQueryClient();

  const shareQuery = useQuery({
    queryKey: ["share", shareId],
    queryFn: () => getShare(shareId),
    refetchInterval: 15_000,
    retry: 1,
  });
  const share = shareQuery.data?.share;
  const active = share?.status === "active";

  const positionsQuery = useQuery({
    queryKey: ["share-positions", shareId],
    queryFn: () => getPositions(shareId),
    enabled: active === true,
    refetchInterval: 10_000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 409) && failureCount < 2,
  });

  const positions = positionsQuery.data;
  const participants = positions?.participants ?? [];
  const myRow = participants.find((participant) => participant.isYou) ?? null;
  const sharing = myRow?.sharing ?? false;

  const serverNow = useServerNow(positions?.share.serverTime ?? share?.serverTime ?? null);
  const remaining = share ? Math.max(0, Date.parse(share.expiresAt) - serverNow) : 0;

  const [view, setView] = useState<"list" | "map">("list");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [permissionProblem, setPermissionProblem] = useState<
    "denied" | "unavailable" | "unsupported" | null
  >(null);
  const [geoState, setGeoState] = useState<GeoPermission | null>(null);
  const [publisherState, setPublisherState] = useState<PublisherState>("idle");
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    void readGeoPermission().then(setGeoState);
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Links minted at creation time are cached for this tab only: they are
  // secrets, so they are never written to the persisted query cache.
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(`${PENDING_INVITE_PREFIX}${shareId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PendingInvite[];
      if (Array.isArray(parsed)) setInvites(parsed);
    } catch {
      // A malformed record is not worth surfacing; links can be regenerated.
    }
  }, [shareId]);

  // Publishing: starts only when this user has opted in (`sharing`), the share
  // is active, and the page is visible (handled inside the publisher).
  useEffect(() => {
    if (!active || !sharing) return;
    const stop = startPublisher({
      publish: async (fix) => {
        try {
          const payload = await publishPosition(shareId, fix);
          queryClient.setQueryData(["share-positions", shareId], payload);
          return "ok";
        } catch (publishError) {
          if (publishError instanceof ApiError && publishError.status === 409) return "ended";
          if (publishError instanceof ApiError && publishError.status === 429) return "throttled";
          return "error";
        }
      },
      onState: setPublisherState,
    });
    return () => {
      stop();
      setPublisherState("idle");
    };
  }, [active, sharing, shareId, queryClient]);

  useEffect(() => {
    if (publisherState !== "ended") return;
    void shareQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: ["shares"] });
  }, [publisherState, shareQuery, queryClient]);

  useEffect(() => {
    if (positionsQuery.error instanceof ApiError && positionsQuery.error.status === 409) {
      void shareQuery.refetch();
    }
  }, [positionsQuery.error, shareQuery]);

  async function enableSharing() {
    setBusy(true);
    setActionError(null);
    setPermissionProblem(null);
    const permission = await requestCurrentPosition();
    if (!permission.ok) {
      setPermissionProblem(permission.reason);
      setBusy(false);
      return;
    }
    try {
      const payload = await setSharing(shareId, true);
      queryClient.setQueryData(["share-positions", shareId], payload);
      setGeoState("granted");
    } catch (sharingError) {
      setActionError(shareErrorMessage(sharingError));
    }
    setBusy(false);
  }

  async function pauseSharing() {
    setBusy(true);
    setActionError(null);
    try {
      const payload = await setSharing(shareId, false);
      queryClient.setQueryData(["share-positions", shareId], payload);
    } catch (sharingError) {
      setActionError(shareErrorMessage(sharingError));
    }
    setBusy(false);
  }

  async function endNow() {
    setBusy(true);
    setActionError(null);
    try {
      await endShare(shareId);
      setConfirmEnd(false);
      await queryClient.invalidateQueries({ queryKey: ["share", shareId] });
      void queryClient.invalidateQueries({ queryKey: ["shares"] });
      void queryClient.invalidateQueries({ queryKey: ["share-positions", shareId] });
    } catch (endError) {
      setActionError(shareErrorMessage(endError));
    }
    setBusy(false);
  }

  async function leaveNow() {
    setBusy(true);
    setActionError(null);
    try {
      await leaveShare(shareId);
      queryClient.removeQueries({ queryKey: ["share-positions", shareId] });
      queryClient.removeQueries({ queryKey: ["share", shareId] });
      void queryClient.invalidateQueries({ queryKey: ["shares"] });
      navigate("/share");
    } catch (leaveError) {
      setActionError(shareErrorMessage(leaveError));
      setBusy(false);
    }
  }

  async function inviteMore() {
    setBusy(true);
    setActionError(null);
    try {
      const minted = await mintInvite(shareId);
      // Regenerating revokes the share's other unaccepted links, so the old
      // entries in the UI are dead and must be replaced, not appended.
      const next: PendingInvite[] = minted.invites.map((invite) => ({
        ...invite,
        forName: null,
      }));
      setInvites(next);
      try {
        window.sessionStorage.setItem(`${PENDING_INVITE_PREFIX}${shareId}`, JSON.stringify(next));
      } catch {
        // Not fatal: the links are on screen and can be regenerated.
      }
    } catch (inviteError) {
      setActionError(shareErrorMessage(inviteError));
    }
    setBusy(false);
  }

  async function copyInvite(invite: PendingInvite) {
    const url = shareUrl(invite.url);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(invite.id);
      window.setTimeout(() => setCopiedId((current) => (current === invite.id ? null : current)), 2_000);
    } catch {
      setActionError("Couldn't copy automatically — press and hold the link to copy it.");
    }
  }

  async function shareInvite(invite: PendingInvite) {
    const url = shareUrl(invite.url);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "Join my Live Share",
          text: "Join my Live Share — it expires when the share ends.",
          url,
        });
        return;
      } catch {
        // Dismissal is not an error; fall through to copying.
      }
    }
    await copyInvite(invite);
  }

  async function remove(userId: string) {
    setActionError(null);
    try {
      await removeParticipant(shareId, userId);
      void queryClient.invalidateQueries({ queryKey: ["share-positions", shareId] });
    } catch (removeError) {
      setActionError(shareErrorMessage(removeError));
    }
  }

  if (shareQuery.isPending) {
    return (
      <div className="app">
        <AppHeader active="share" />
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

  if (shareQuery.isError || !share) {
    return (
      <div className="app">
        <AppHeader active="share" />
        <main className="screen">
          <div className="empty">
            <p className="empty-title">This share isn&apos;t available</p>
            <p className="empty-sub">{shareErrorMessage(shareQuery.error)}</p>
            <a className="button button--compact" {...linkProps("/share")}>
              Back to shares
            </a>
          </div>
        </main>
      </div>
    );
  }

  const ended = share.status === "ended";
  const isOwner = share.role === "owner";
  const viewerPoint =
    myRow && myRow.lat !== null && myRow.lng !== null
      ? { lat: myRow.lat, lng: myRow.lng }
      : null;
  const anyLocated = participants.some(
    (participant) => participant.lat !== null && participant.lng !== null,
  );
  const permissionHelp = permissionProblem ? PERMISSION_HELP[permissionProblem] : null;

  return (
    <div className="app">
      <AppHeader active="share" />

      {!online ? (
        <div className="status-bar" role="status">
          Offline — your location isn&apos;t updating.
        </div>
      ) : null}

      <main className="screen">
        <div className="screen-head">
          <h1 className="screen-title">Live Share</h1>
          <span className="screen-meta">
            {ended
              ? `Ended ${formatTime(share.endedAt ?? share.expiresAt)}`
              : `Ends in ${formatCountdown(remaining)}`}
          </span>
        </div>

        {ended ? (
          <div className="share-tile">
            <p className="share-ended-line">
              This share has ended. Locations are no longer visible to anyone.
            </p>
            {isOwner && share.events && share.events.length > 0 ? (
              <ul className="share-events" aria-label="Share activity">
                {share.events.map((event) => (
                  <li key={event.id}>
                    <span className="share-event-time">{formatTime(event.createdAt)}</span>
                    <span>
                      {event.actorName ? `${event.actorName} ` : ""}
                      {EVENT_LABEL[event.kind] ?? event.kind}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="share-actions">
              <a className="button button--primary button--compact" {...linkProps("/share/new")}>
                Share again
              </a>
              <a className="button button--compact" {...linkProps("/share")}>
                Back to shares
              </a>
            </div>
          </div>
        ) : (
          <>
            {sharing ? (
              <div className="share-callout share-callout--on">
                <p className="share-callout-title">You&apos;re sharing your location</p>
                <p className="share-callout-sub">
                  Updates stop if you close the app or lock the phone — keep this screen open.
                </p>
                <button
                  className="button button--compact"
                  type="button"
                  onClick={() => void pauseSharing()}
                  disabled={busy}
                >
                  Stop sharing my location
                </button>
              </div>
            ) : (
              <div className="share-callout share-callout--off">
                <p className="share-callout-title">Your location is off</p>
                <p className="share-callout-sub">
                  {geoState === "denied"
                    ? "You said no to location on this device, so nobody can see you. You can still see everyone else."
                    : "Others can't see you until you turn this on."}
                </p>
                {permissionHelp ? (
                  <p className="share-help" role="status">
                    {permissionHelp}
                  </p>
                ) : null}
                <button
                  className="button button--primary button--compact"
                  type="button"
                  onClick={() => void enableSharing()}
                  disabled={busy}
                >
                  {busy ? "Starting…" : "Share my location"}
                </button>
              </div>
            )}

            {publisherState === "error" && sharing ? (
              <p className="status-bar" role="status">
                Your location isn&apos;t updating right now. Keep this screen open and try again.
              </p>
            ) : null}

            <div className="share-view-toggle" role="group" aria-label="View">
              <button
                type="button"
                className={`share-tab${view === "list" ? " is-selected" : ""}`}
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                List
              </button>
              <button
                type="button"
                className={`share-tab${view === "map" ? " is-selected" : ""}`}
                aria-pressed={view === "map"}
                onClick={() => setView("map")}
              >
                Map
              </button>
            </div>

            {view === "map" ? (
              anyLocated ? (
                <Suspense
                  fallback={
                    <div className="share-map-placeholder" role="status">
                      Loading map…
                    </div>
                  }
                >
                  <ShareMap participants={participants} serverTime={share.serverTime} />
                </Suspense>
              ) : (
                <div className="share-map-placeholder">
                  No positions yet — the map appears as soon as someone shares theirs.
                </div>
              )
            ) : null}

            <section className="share-section" aria-label="People">
              {positionsQuery.isPending ? (
                <div className="skeleton-stack" aria-hidden="true">
                  <div className="skeleton skeleton-row" />
                </div>
              ) : (
                <ul className="share-people">
                  {participants.map((participant) => {
                    const state = classifyParticipant(participant, share.serverTime).state;
                    const distance = distanceTo(viewerPoint, participant);
                    const accuracy = participant.accuracy;
                    const accuracyLabel =
                      accuracy === null
                        ? ""
                        : accuracy > 200
                          ? "approximate"
                          : `±${Math.round(accuracy)} m`;
                    const meta = [describeParticipant(participant, share.serverTime)];
                    if (distance !== null && !participant.isYou) {
                      meta.push(`about ${formatDistance(distance)} away`);
                    }
                    if (accuracyLabel) meta.push(accuracyLabel);
                    return (
                      <li key={participant.userId} className={`share-person share-person--${state}`}>
                        <span className="share-avatar" aria-hidden="true">
                          {initialOf(participant.displayName)}
                        </span>
                        <span className="share-person-main">
                          <span className="share-person-name">
                            {participant.displayName}
                            {participant.isYou ? " (you)" : ""}
                          </span>
                          <span className="share-person-meta">{meta.join(" · ")}</span>
                        </span>
                        {isOwner && !participant.isYou && participant.role === "guest" ? (
                          <button
                            className="link-button link-button--muted"
                            type="button"
                            onClick={() => void remove(participant.userId)}
                            aria-label={`Remove ${participant.displayName} from the share`}
                          >
                            Remove
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {isOwner ? (
              <section className="share-section" aria-label="Invite">
                <h2 className="share-section-title">Invite someone</h2>
                {invites.length === 0 ? (
                  <p className="field-note">
                    Each link works once and expires with the share. Send one link to one person.
                  </p>
                ) : (
                  <ul className="share-invites">
                    {invites.map((invite) => (
                      <li key={invite.id} className="share-invite">
                        <span className="share-invite-label">
                          {invite.forName ? `For ${invite.forName}` : "Single-use link"}
                        </span>
                        <code className="share-invite-url">{shareUrl(invite.url)}</code>
                        <span className="share-invite-actions">
                          <button
                            className="link-button"
                            type="button"
                            onClick={() => void copyInvite(invite)}
                          >
                            {copiedId === invite.id ? "Copied" : "Copy"}
                          </button>
                          <button
                            className="link-button"
                            type="button"
                            onClick={() => void shareInvite(invite)}
                          >
                            Send
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  className="button button--compact"
                  type="button"
                  onClick={() => void inviteMore()}
                  disabled={busy}
                >
                  {invites.length === 0 ? "Create a link" : "Create another link"}
                </button>
              </section>
            ) : null}

            {actionError ? (
              <p className="status-bar" role="alert">
                {actionError}
              </p>
            ) : null}

            <div className="share-actions share-actions--footer">
              {isOwner ? (
                confirmEnd ? (
                  <div className="share-confirm">
                    <p>End it for everyone? Locations are deleted.</p>
                    <div className="share-actions">
                      <button
                        className="button button--danger button--compact"
                        type="button"
                        onClick={() => void endNow()}
                        disabled={busy}
                      >
                        End now
                      </button>
                      <button
                        className="button button--compact"
                        type="button"
                        onClick={() => setConfirmEnd(false)}
                      >
                        Keep sharing
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="button button--compact"
                    type="button"
                    onClick={() => setConfirmEnd(true)}
                  >
                    End share
                  </button>
                )
              ) : confirmLeave ? (
                <div className="share-confirm">
                  <p>Leave this share? Your location stops being visible.</p>
                  <div className="share-actions">
                    <button
                      className="button button--danger button--compact"
                      type="button"
                      onClick={() => void leaveNow()}
                      disabled={busy}
                    >
                      Leave
                    </button>
                    <button
                      className="button button--compact"
                      type="button"
                      onClick={() => setConfirmLeave(false)}
                    >
                      Stay
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="button button--compact"
                  type="button"
                  onClick={() => setConfirmLeave(true)}
                >
                  Leave share
                </button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function initialOf(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
