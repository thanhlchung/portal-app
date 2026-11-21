import type {
  InviteView,
  ParticipantView,
  PositionsPayload,
  RecentPersonView,
  ShareSummary,
} from "@portal/api";
import { api, ApiError, unwrap } from "./api";
import type { GeoFix } from "./location";

/**
 * Typed Live Share client. Every call goes through `hc<AppType>`, so a field
 * renamed on the server breaks `pnpm typecheck` here instead of failing at
 * runtime — the same contract as notes and scores.
 */

export type PreviewInvite =
  | { alreadyMember: true; share: ShareSummary }
  | {
      alreadyMember: false;
      inviterName: string;
      expiresAt: string;
      remainingMinutes: number;
    };

export interface CreateShareInput {
  durationMinutes: 15 | 30 | 60 | 120 | null;
  inviteCount?: number;
}

export async function listShares(): Promise<{ shares: ShareSummary[]; serverTime: string }> {
  return unwrap(await api.shares.$get());
}

export async function createShare(
  input: CreateShareInput,
): Promise<{ share: ShareSummary; invites: InviteView[] }> {
  return unwrap(
    await api.shares.$post({
      json: {
        durationMinutes: input.durationMinutes,
        inviteCount: input.inviteCount ?? 1,
      },
    }),
  );
}

export async function getShare(id: string): Promise<{ share: ShareSummary }> {
  return unwrap(await api.shares[":id"].$get({ param: { id } }));
}

export async function getPositions(id: string): Promise<PositionsPayload> {
  return unwrap(await api.shares[":id"].positions.$get({ param: { id } }));
}

export async function publishPosition(id: string, fix: GeoFix): Promise<PositionsPayload> {
  return unwrap(
    await api.shares[":id"].positions.$post({
      param: { id },
      json: {
        lat: fix.lat,
        lng: fix.lng,
        accuracy: fix.accuracy ?? 0,
      },
    }),
  );
}

export async function setSharing(id: string, sharing: boolean): Promise<PositionsPayload> {
  return unwrap(await api.shares[":id"].me.$patch({ param: { id }, json: { sharing } }));
}

export async function endShare(id: string): Promise<{ share: ShareSummary }> {
  return unwrap(await api.shares[":id"].end.$post({ param: { id } }));
}

export async function leaveShare(id: string): Promise<{ share: ShareSummary }> {
  return unwrap(await api.shares[":id"].leave.$post({ param: { id } }));
}

export async function removeParticipant(
  id: string,
  userId: string,
): Promise<{ share: ShareSummary }> {
  return unwrap(
    await api.shares[":id"].participants[":userId"].remove.$post({
      param: { id, userId },
    }),
  );
}

export async function mintInvite(id: string): Promise<{ invites: InviteView[] }> {
  return unwrap(await api.shares[":id"].invites.$post({ param: { id } }));
}

export async function previewInvite(token: string): Promise<PreviewInvite> {
  return unwrap<PreviewInvite>(
    await api.shares["join-preview"].$get({ query: { token } }),
  );
}

export async function joinShare(
  token: string,
): Promise<{ alreadyMember: boolean; share: ShareSummary }> {
  return unwrap(await api.shares.join.$post({ json: { token } }));
}

export async function recentPeople(): Promise<{ people: RecentPersonView[] }> {
  return unwrap(await api.people.recent.$get());
}

/** Absolute URL for a link the user is about to send someone. */
export function shareUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

/** Turn API failures into a sentence a person can act on. */
export function shareErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "You need to sign in again.";
    if (error.status === 410) {
      if (error.code === "invite_used") return "That link has already been used. Ask for a new one.";
      if (error.code === "invite_revoked") return "That link was replaced. Ask for a new one.";
      return "That link has expired. Ask for a new one.";
    }
    if (error.status === 409) {
      if (error.code === "share_ended") return "This share has ended.";
      if (error.code === "share_full") return "This share is full.";
      if (error.code === "too_many_active_shares") {
        return "You already have three shares open — end one first.";
      }
      if (error.code === "not_sharing") return "Turn on location sharing first.";
      return "This share can't be updated right now.";
    }
    if (error.status === 404) {
      if (error.code === "invite_not_found") return "That link doesn't exist. Check it and try again.";
      return "That share isn't available any more.";
    }
    if (error.status === 429) {
      return "The server asked us to slow down — try again in a moment.";
    }
    if (error.status >= 500) {
      return "The server is waking up. This can take up to 30 seconds — try again.";
    }
  }
  if (error instanceof TypeError) return "You're offline — this will retry when the network returns.";
  return "Something went wrong. Try again.";
}

export type { InviteView, ParticipantView, PositionsPayload, RecentPersonView, ShareSummary };
